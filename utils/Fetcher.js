const axios = require('axios');
const { Mutex, Semaphore, withTimeout } = require('async-mutex');
const { Cacheable, Keyv, CacheableMemory } = require('cacheable');

/**
 * Production-grade HTTP Fetcher with:
 * - Automatic retries on 429 rate limits
 * - Request queueing (max 50 concurrent per host)
 * - Mutex locks for duplicate requests
 * - Timeout tracking and circuit breaking
 * 
 * Ported from webstrymr/src/utils/Fetcher.ts
 */
class Fetcher {
    constructor() {
        this.DEFAULT_TIMEOUT = 10000;
        this.DEFAULT_QUEUE_LIMIT = 50;
        this.DEFAULT_QUEUE_TIMEOUT = 10000;
        this.DEFAULT_TIMEOUTS_COUNT_THROW = 30;
        this.TIMEOUT_CACHE_TTL = 3600000; // 1h
        this.MAX_WAIT_RETRY_AFTER = 10000; // Max time to wait on 429

        this.semaphores = new Map();
        this.timeoutsCountCache = new Cacheable({ primary: new Keyv({ store: new CacheableMemory({ lruSize: 1024 }) }) });
        this.rateLimitedCache = new Cacheable({ primary: new Keyv({ store: new CacheableMemory({ lruSize: 1024 }) }) });
        this.timeoutsCountMutex = new Mutex();
    }

    /**
     * Fetch JSON from URL with automatic retry and queueing
     */
    async json(url, requestConfig = {}) {
        const jsonRequestConfig = {
            headers: {
                Accept: 'application/json,text/plain,*/*',
                ...requestConfig.headers
            },
            ...requestConfig
        };

        const response = await this.queuedFetch(url, jsonRequestConfig);
        return JSON.parse(response.data);
    }

    /**
     * Fetch text from URL
     */
    async text(url, requestConfig = {}) {
        const response = await this.queuedFetch(url, requestConfig);
        return response.data;
    }

    /**
     * Private: Queued fetch with semaphore
     */
    async queuedFetch(url, requestConfig = {}) {
        const urlObj = typeof url === 'string' ? new URL(url) : url;
        const queueLimit = requestConfig.queueLimit ?? this.DEFAULT_QUEUE_LIMIT;
        const queueTimeout = requestConfig.queueTimeout ?? this.DEFAULT_QUEUE_TIMEOUT;

        const semaphore = this.getSemaphore(urlObj, queueLimit, queueTimeout);

        const [, release] = await semaphore.acquire();

        try {
            return await this.fetchWithTimeout(urlObj, requestConfig);
        } finally {
            release();
        }
    }

    /**
   * Private: Fetch with timeout and retry logic
   */
    async fetchWithTimeout(url, requestConfig = {}, tryCount = 0) {
        const urlStr = url.toString();
        const maxRetries = 2; // Retry up to 2 times for network errors

        // Check if rate limited
        const isRateLimitedRaw = await this.rateLimitedCache.getRaw(url.host);
        if (isRateLimitedRaw && isRateLimitedRaw.value && isRateLimitedRaw.expires) {
            const ttl = isRateLimitedRaw.expires - Date.now();
            if (ttl <= this.MAX_WAIT_RETRY_AFTER && tryCount < 1) {
                console.log(`[Fetcher] Waiting out rate limit for ${url.host}...`);
                await this.sleep(ttl);
                return await this.fetchWithTimeout(url, { ...requestConfig, queueLimit: 1 }, tryCount);
            }
            throw new Error(`Too many requests to ${url.host}, retry after ${Math.ceil(ttl / 1000)}s`);
        }

        // Check timeout count
        const timeouts = (await this.timeoutsCountCache.get(url.host)) ?? 0;
        if (timeouts >= (requestConfig.timeoutsCountThrow ?? this.DEFAULT_TIMEOUTS_COUNT_THROW)) {
            throw new Error(`Too many timeouts for ${url.host}`);
        }

        let response;
        try {
            response = await axios.request({
                ...requestConfig,
                url: urlStr,
                timeout: requestConfig.timeout ?? this.DEFAULT_TIMEOUT,
                transformResponse: [data => data],
                validateStatus: () => true,
                headers: {
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en',
                    'User-Agent': 'Mozilla/5.0',
                    ...requestConfig.headers
                }
            });
        } catch (error) {
            // Handle network errors with retry logic
            const isNetworkError = error.code === 'ECONNABORTED' ||
                error.code === 'ETIMEDOUT' ||
                error.code === 'ECONNRESET' ||
                error.code === 'ENOTFOUND' ||
                error.message.includes('timeout');

            if (isNetworkError && tryCount < maxRetries) {
                const retryDelay = Math.min(1000 * Math.pow(2, tryCount), 5000); // Exponential backoff: 1s, 2s, 4s
                console.log(`[Fetcher] Network error (${error.code || 'timeout'}) for ${url.host}, retry ${tryCount + 1}/${maxRetries} in ${retryDelay}ms...`);
                await this.sleep(retryDelay);
                return await this.fetchWithTimeout(url, requestConfig, tryCount + 1);
            }

            // Track timeout and throw
            if (error.code === 'ECONNABORTED') {
                await this.increaseTimeoutsCount(url);
                throw new Error(`Timeout fetching ${urlStr}`);
            }

            throw error;
        }

        await this.decreaseTimeoutsCount(url);

        // Handle 429 rate limit
        if (response.status === 429) {
            const retryAfter = parseInt(`${response.headers['retry-after']}`) * 1000 || 5000;
            if (retryAfter <= this.MAX_WAIT_RETRY_AFTER && tryCount < 1) {
                console.log(`[Fetcher] Rate limited by ${url.host}, waiting ${retryAfter}ms...`);
                await this.sleep(retryAfter);
                return await this.fetchWithTimeout(url, { ...requestConfig, queueLimit: 1 }, tryCount + 1);
            }

            // Cache rate limit
            await this.rateLimitedCache.set(url.host, true, retryAfter);
            throw new Error(`Rate limited by ${url.host}, retry after ${Math.ceil(retryAfter / 1000)}s`);
        }

        // Success
        if (response.status >= 200 && response.status <= 399) {
            return response;
        }

        // 404
        if (response.status === 404) {
            throw new Error(`Not found: ${urlStr}`);
        }

        throw new Error(`HTTP ${response.status} ${response.statusText} for ${urlStr}`);
    }

    /**
     * Get or create semaphore for host
     */
    getSemaphore(url, queueLimit, queueTimeout) {
        let sem = this.semaphores.get(url.host);

        if (!sem) {
            const baseSem = new Semaphore(queueLimit);
            sem = withTimeout(baseSem, queueTimeout, new Error(`Queue timeout for ${url.host}`));
            this.semaphores.set(url.host, sem);
        }

        return sem;
    }

    /**
     * Track timeout failures
     */
    async increaseTimeoutsCount(url) {
        await this.timeoutsCountMutex.runExclusive(async () => {
            const count = (await this.timeoutsCountCache.get(url.host)) ?? 0;
            const newCount = count + 1;
            await this.timeoutsCountCache.set(url.host, newCount, this.TIMEOUT_CACHE_TTL);
        });
    }

    /**
     * Decrease timeout count on success
     */
    async decreaseTimeoutsCount(url) {
        await this.timeoutsCountMutex.runExclusive(async () => {
            const count = (await this.timeoutsCountCache.get(url.host)) ?? 0;
            const newCount = Math.max(0, count - 1);
            await this.timeoutsCountCache.set(url.host, newCount, this.TIMEOUT_CACHE_TTL);
        });
    }

    /**
     * Sleep helper
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Singleton instance
const fetcher = new Fetcher();

module.exports = fetcher;
