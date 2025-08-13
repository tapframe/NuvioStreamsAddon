require('dotenv').config();
const Redis = require('ioredis');
const fs = require('fs').promises;
const path = require('path');

// Redis Cache Utility for NuvioStreams Providers
class RedisCache {
    constructor(providerName = 'Generic') {
        this.providerName = providerName;
        this.redisClient = null;
        this.redisKeepAliveInterval = null;
        this.initializeRedis();
    }

    initializeRedis() {
        if (process.env.USE_REDIS_CACHE === 'true') {
            try {
                console.log(`[${this.providerName} Cache] Initializing Redis. REDIS_URL from env: ${process.env.REDIS_URL ? 'exists and has value' : 'MISSING or empty'}`);
                if (!process.env.REDIS_URL) {
                    throw new Error(`REDIS_URL environment variable is not set or is empty for ${this.providerName} Redis.`);
                }

                // Check if this is a local Redis instance or remote
                const isLocal = process.env.REDIS_URL.includes('localhost') || process.env.REDIS_URL.includes('127.0.0.1');
                
                this.redisClient = new Redis(process.env.REDIS_URL, {
                    maxRetriesPerRequest: 5,
                    retryStrategy(times) {
                        const delay = Math.min(times * 500, 5000);
                        return delay;
                    },
                    reconnectOnError: function(err) {
                        const targetError = 'READONLY';
                        if (err.message.includes(targetError)) {
                            return true;
                        }
                        return false;
                    },
                    // TLS is optional - only use if explicitly specified with rediss:// protocol
                     tls: process.env.REDIS_URL.startsWith('rediss://') ? {} : undefined,
                    enableOfflineQueue: true,
                    enableReadyCheck: true,
                    autoResubscribe: true,
                    autoResendUnfulfilledCommands: true,
                    lazyConnect: false
                });

                this.redisClient.on('connect', () => {
                    console.log(`[${this.providerName} Cache] Successfully connected to Redis server.`);
                    
                    // Redis Keep-Alive for managed services like Upstash
                    if (this.redisKeepAliveInterval) {
                        clearInterval(this.redisKeepAliveInterval);
                    }
                    this.redisKeepAliveInterval = setInterval(async () => {
                        try {
                            await this.redisClient.ping();
                        } catch (pingError) {
                            console.warn(`[${this.providerName} Cache] Redis keep-alive ping failed: ${pingError.message}`);
                        }
                    }, 4 * 60 * 1000); // 4 minutes
                });

                this.redisClient.on('error', (err) => {
                    console.error(`[${this.providerName} Cache] Redis connection error: ${err.message}`);
                });

                this.redisClient.on('close', () => {
                    console.log(`[${this.providerName} Cache] Redis connection closed.`);
                    if (this.redisKeepAliveInterval) {
                        clearInterval(this.redisKeepAliveInterval);
                        this.redisKeepAliveInterval = null;
                    }
                });

            } catch (initError) {
                console.error(`[${this.providerName} Cache] Failed to initialize Redis client: ${initError.message}`);
                this.redisClient = null;
            }
        } else {
            console.log(`[${this.providerName} Cache] Redis cache is disabled (USE_REDIS_CACHE is not 'true'). Using file system cache only.`);
        }
    }

    async getFromCache(cacheKey, subDir = '', cacheDir = null) {
        if (process.env.DISABLE_CACHE === 'true') {
            console.log(`[${this.providerName} Cache] CACHE DISABLED: Skipping read for ${path.join(subDir, cacheKey)}`);
            return null;
        }

        const fullCacheKey = subDir ? `${this.providerName.toLowerCase()}:${subDir}:${cacheKey}` : `${this.providerName.toLowerCase()}:${cacheKey}`;

        // Try to get from Redis first
        if (this.redisClient && this.redisClient.status === 'ready') {
            try {
                const redisData = await this.redisClient.get(fullCacheKey);
                if (redisData !== null) {
                    console.log(`[${this.providerName} Cache] REDIS CACHE HIT for: ${fullCacheKey}`);
                    try {
                        return JSON.parse(redisData);
                    } catch (e) {
                        return redisData;
                    }
                }
                console.log(`[${this.providerName} Cache] REDIS CACHE MISS for: ${fullCacheKey}`);
            } catch (redisError) {
                console.warn(`[${this.providerName} Cache] REDIS CACHE READ ERROR for ${fullCacheKey}: ${redisError.message}. Falling back to file system cache.`);
            }
        } else if (this.redisClient) {
            console.log(`[${this.providerName} Cache] Redis client not ready (status: ${this.redisClient.status}). Skipping Redis read for ${fullCacheKey}, trying file system.`);
        }

        // Fallback to file system cache
        if (cacheDir) {
            const cachePath = path.join(cacheDir, subDir, `${cacheKey}.json`);
            try {
                const fileData = await fs.readFile(cachePath, 'utf-8');
                console.log(`[${this.providerName} Cache] FILE SYSTEM CACHE HIT for: ${path.join(subDir, cacheKey)}`);
                
                // If Redis is available, populate Redis for next time (permanent cache)
                if (this.redisClient && this.redisClient.status === 'ready') {
                    try {
                        await this.redisClient.set(fullCacheKey, fileData);
                        console.log(`[${this.providerName} Cache] Populated REDIS CACHE from FILE SYSTEM for: ${fullCacheKey} (PERMANENT - no expiration)`);
                    } catch (redisSetError) {
                        console.warn(`[${this.providerName} Cache] REDIS CACHE SET ERROR (after file read) for ${fullCacheKey}: ${redisSetError.message}`);
                    }
                }
                
                try {
                    return JSON.parse(fileData);
                } catch (e) {
                    return fileData;
                }
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    console.warn(`[${this.providerName} Cache] FILE SYSTEM CACHE READ ERROR for ${cacheKey}: ${error.message}`);
                } else {
                    console.log(`[${this.providerName} Cache] FILE SYSTEM CACHE MISS for: ${path.join(subDir, cacheKey)}`);
                }
                return null;
            }
        }

        return null;
    }

    async saveToCache(cacheKey, content, subDir = '', cacheDir = null, ttlSeconds = null) {
        if (process.env.DISABLE_CACHE === 'true') {
            console.log(`[${this.providerName} Cache] CACHE DISABLED: Skipping write for ${path.join(subDir, cacheKey)}`);
            return;
        }

        const dataToSave = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
        const fullCacheKey = subDir ? `${this.providerName.toLowerCase()}:${subDir}:${cacheKey}` : `${this.providerName.toLowerCase()}:${cacheKey}`;

        // Attempt to save to Redis first with optional TTL
        if (this.redisClient && this.redisClient.status === 'ready') {
            try {
                if (ttlSeconds) {
                    await this.redisClient.setex(fullCacheKey, ttlSeconds, dataToSave);
                    console.log(`[${this.providerName} Cache] SAVED TO REDIS CACHE: ${fullCacheKey} (TTL: ${ttlSeconds}s)`);
                } else {
                    await this.redisClient.set(fullCacheKey, dataToSave);
                    console.log(`[${this.providerName} Cache] SAVED TO REDIS CACHE: ${fullCacheKey} (PERMANENT - no expiration)`);
                }
            } catch (redisError) {
                console.warn(`[${this.providerName} Cache] REDIS CACHE WRITE ERROR for ${fullCacheKey}: ${redisError.message}. Proceeding with file system cache.`);
            }
        } else if (this.redisClient) {
            console.log(`[${this.providerName} Cache] Redis client not ready (status: ${this.redisClient.status}). Skipping Redis write for ${fullCacheKey}.`);
        }

        // Always save to file system cache as a fallback
        if (cacheDir) {
            try {
                const fullSubDir = path.join(cacheDir, subDir);
                await this.ensureCacheDir(fullSubDir);
                const cachePath = path.join(fullSubDir, `${cacheKey}.json`);
                await fs.writeFile(cachePath, dataToSave, 'utf-8');
                console.log(`[${this.providerName} Cache] SAVED TO FILE SYSTEM CACHE: ${path.join(subDir, cacheKey)}`);
            } catch (error) {
                console.warn(`[${this.providerName} Cache] FILE SYSTEM CACHE WRITE ERROR for ${cacheKey}: ${error.message}`);
            }
        }
    }

    // TTL method removed - all cache entries are now permanent
    // getTTLForSubDir(subDir) {
    //     // This method is no longer used as all cache entries are permanent
    //     // Previously configured TTL based on data type but now all data persists indefinitely
    // }

    async ensureCacheDir(dirPath) {
        try {
            await fs.mkdir(dirPath, { recursive: true });
        } catch (error) {
            if (error.code !== 'EEXIST') {
                console.warn(`[${this.providerName} Cache] Warning: Could not create cache directory ${dirPath}: ${error.message}`);
            }
        }
    }

    // Cleanup method
    cleanup() {
        if (this.redisKeepAliveInterval) {
            clearInterval(this.redisKeepAliveInterval);
            this.redisKeepAliveInterval = null;
        }
        if (this.redisClient) {
            this.redisClient.disconnect();
            this.redisClient = null;
        }
    }
}

module.exports = RedisCache;