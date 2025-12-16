// ================================================================================
// Nuvio Streams Addon for Stremio
// ================================================================================
// 
// GOOGLE ANALYTICS SETUP:
// 1. Go to https://analytics.google.com/ and create a new GA4 property
// 2. Get your Measurement ID (format: G-XXXXXXXXXX)
// 3. Replace 'G-XXXXXXXXXX' in views/index.html with your actual Measurement ID
// 4. The addon will automatically track:
//    - Addon installations (install_addon_clicked)
//    - Manifest copies (copy_manifest_clicked)
//    - Provider configurations (apply_providers_clicked)
//    - Cookie configurations (set_cookie_clicked)
//    - Tutorial access (cookie_tutorial_opened)
//    - Stream requests (will be added to server-side logging)
//
// ================================================================================

const { addonBuilder } = require('stremio-addon-sdk');
require('dotenv').config(); // Ensure environment variables are loaded
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto'); // For hashing cookies
const Redis = require('ioredis');

// Add Redis client if enabled
const USE_REDIS_CACHE = process.env.USE_REDIS_CACHE === 'true';
let redis = null;
let redisKeepAliveInterval = null; // Variable to manage the keep-alive interval

if (USE_REDIS_CACHE) {
    try {
        console.log(`[Redis Cache] Initializing Redis in addon.js. REDIS_URL from env: ${process.env.REDIS_URL ? 'exists and has value' : 'MISSING or empty'}`);
        if (!process.env.REDIS_URL) {
            throw new Error("REDIS_URL environment variable is not set or is empty.");
        }
        
        // Check if this is a local Redis instance or remote
        const isLocal = process.env.REDIS_URL.includes('localhost') || process.env.REDIS_URL.includes('127.0.0.1');
        
        redis = new Redis(process.env.REDIS_URL, {
            maxRetriesPerRequest: 5,
            retryStrategy(times) {
                const delay = Math.min(times * 500, 5000);
                // Added verbose logging for each retry attempt
                console.warn(`[Redis Cache] Retry strategy activated. Attempt #${times}, will retry in ${delay}ms`);
                return delay;
            },
            reconnectOnError: function(err) {
                const targetError = 'READONLY';
                const shouldReconnect = err.message.includes(targetError);
                // Added detailed logging for reconnectOnError decisions
                console.warn(`[Redis Cache] reconnectOnError invoked due to error: "${err.message}". Decided to reconnect: ${shouldReconnect}`);
                return shouldReconnect;
            },
            // TLS is optional - only use if explicitly specified with rediss:// protocol
            tls: process.env.REDIS_URL.startsWith('rediss://') ? {} : undefined,
            enableOfflineQueue: true,
            enableReadyCheck: true,
            autoResubscribe: true,
            autoResendUnfulfilledCommands: true,
            lazyConnect: false
        });
        
        redis.on('error', (err) => {
            console.error(`[Redis Cache] Connection error: ${err.message}`);
            // --- BEGIN: Clear Keep-Alive on Error ---
            if (redisKeepAliveInterval) {
                clearInterval(redisKeepAliveInterval);
                redisKeepAliveInterval = null;
            }
            // --- END: Clear Keep-Alive on Error ---
        });
        
        redis.on('connect', () => {
            console.log('[Redis Cache] Successfully connected to Upstash Redis');

            // --- BEGIN: Redis Keep-Alive ---
            if (redisKeepAliveInterval) {
                clearInterval(redisKeepAliveInterval);
            }

            redisKeepAliveInterval = setInterval(() => {
                if (redis && redis.status === 'ready') {
                    redis.ping((err) => {
                        if (err) {
                            console.error('[Redis Cache Keep-Alive] Ping failed:', err.message);
                        }
                    });
                }
            }, 4 * 60 * 1000); // 4 minutes
            // --- END: Redis Keep-Alive ---
        });
        
        // --- BEGIN: Additional Redis connection lifecycle logging ---
        redis.on('reconnecting', (delay) => {
            console.warn(`[Redis Cache] Reconnecting... next attempt in ${delay}ms (current status: ${redis.status})`);
        });
        redis.on('close', () => {
            console.warn('[Redis Cache] Connection closed.');
        });
        redis.on('end', () => {
            console.error('[Redis Cache] Connection ended. No further reconnection attempts will be made.');
        });
        redis.on('ready', () => {
            console.log('[Redis Cache] Connection is ready and commands can now be processed.');
        });
        // --- END: Additional Redis connection lifecycle logging ---
        
        console.log('[Redis Cache] Upstash Redis client initialized');
    } catch (err) {
        console.error(`[Redis Cache] Failed to initialize Redis: ${err.message}`);
        console.log('[Redis Cache] Will use file-based cache as fallback');
    }
}

// (Removed) Cuevana, HollyMovieHD, Xprime provider flags

// NEW: Read environment variable for VidZee
const ENABLE_VIDZEE_PROVIDER = process.env.ENABLE_VIDZEE_PROVIDER !== 'false'; // Defaults to true
console.log(`[addon.js] VidZee provider fetching enabled: ${ENABLE_VIDZEE_PROVIDER}`);

// NEW: Read environment variable for MP4Hydra
const ENABLE_MP4HYDRA_PROVIDER = process.env.ENABLE_MP4HYDRA_PROVIDER !== 'false'; // Defaults to true if not set or not 'false'
console.log(`[addon.js] MP4Hydra provider fetching enabled: ${ENABLE_MP4HYDRA_PROVIDER}`);

// (Removed) HiAnime provider flag

// NEW: Read environment variable for UHDMovies
const ENABLE_UHDMOVIES_PROVIDER = process.env.ENABLE_UHDMOVIES_PROVIDER !== 'false'; // Defaults to true if not set or not 'false'
console.log(`[addon.js] UHDMovies provider fetching enabled: ${ENABLE_UHDMOVIES_PROVIDER}`);

// (Removed) AnimePahe provider flag

// NEW: Read environment variable for MoviesMod
const ENABLE_MOVIESMOD_PROVIDER = process.env.ENABLE_MOVIESMOD_PROVIDER !== 'false'; // Defaults to true if not set or not 'false'
console.log(`[addon.js] MoviesMod provider fetching enabled: ${ENABLE_MOVIESMOD_PROVIDER}`);

// NEW: Read environment variable for TopMovies
const ENABLE_TOPMOVIES_PROVIDER = process.env.ENABLE_TOPMOVIES_PROVIDER !== 'false'; // Defaults to true if not set or not 'false'
console.log(`[addon.js] TopMovies provider fetching enabled: ${ENABLE_TOPMOVIES_PROVIDER}`);

// NEW: Read environment variable for SoaperTV
const ENABLE_SOAPERTV_PROVIDER = process.env.ENABLE_SOAPERTV_PROVIDER !== 'false'; // Defaults to true
console.log(`[addon.js] SoaperTV provider fetching enabled: ${ENABLE_SOAPERTV_PROVIDER}`);



// NEW: Read environment variable for MoviesDrive
const ENABLE_MOVIESDRIVE_PROVIDER = process.env.ENABLE_MOVIESDRIVE_PROVIDER !== 'false'; // Defaults to true if not set or not 'false'
console.log(`[addon.js] MoviesDrive provider fetching enabled: ${ENABLE_MOVIESDRIVE_PROVIDER}`);

// NEW: Read environment variable for 4KHDHub
const ENABLE_4KHDHUB_PROVIDER = process.env.ENABLE_4KHDHUB_PROVIDER !== 'false'; // Defaults to true if not set or not 'false'
console.log(`[addon.js] 4KHDHub provider fetching enabled: ${ENABLE_4KHDHUB_PROVIDER}`);

// NEW: Read environment variable for Vixsrc
const ENABLE_VIXSRC_PROVIDER = process.env.ENABLE_VIXSRC_PROVIDER !== 'false'; // Defaults to true if not set or not 'false'
console.log(`[addon.js] Vixsrc provider fetching enabled: ${ENABLE_VIXSRC_PROVIDER}`);

// NEW: Read environment variable for MovieBox
const ENABLE_MOVIEBOX_PROVIDER = process.env.ENABLE_MOVIEBOX_PROVIDER !== 'false'; // Defaults to true if not set or not 'false'
console.log(`[addon.js] MovieBox provider fetching enabled: ${ENABLE_MOVIEBOX_PROVIDER}`);

// External provider service configuration
const USE_EXTERNAL_PROVIDERS = process.env.USE_EXTERNAL_PROVIDERS === 'true';
const EXTERNAL_UHDMOVIES_URL = USE_EXTERNAL_PROVIDERS ? process.env.EXTERNAL_UHDMOVIES_URL : null;
const EXTERNAL_TOPMOVIES_URL = USE_EXTERNAL_PROVIDERS ? process.env.EXTERNAL_TOPMOVIES_URL : null;
const EXTERNAL_MOVIESMOD_URL = USE_EXTERNAL_PROVIDERS ? process.env.EXTERNAL_MOVIESMOD_URL : null;

console.log(`[addon.js] External providers: ${USE_EXTERNAL_PROVIDERS ? 'enabled' : 'disabled'}`);
if (USE_EXTERNAL_PROVIDERS) {
    console.log(`[addon.js] External UHDMovies URL: ${EXTERNAL_UHDMOVIES_URL || 'Not configured (using local)'}`); 
    // (Removed) External DramaDrip URL log
    console.log(`[addon.js] External TopMovies URL: ${EXTERNAL_TOPMOVIES_URL || 'Not configured (using local)'}`); 
    console.log(`[addon.js] External MoviesMod URL: ${EXTERNAL_MOVIESMOD_URL || 'Not configured (using local)'}`); 
} else {
    console.log(`[addon.js] All providers will use local implementations`);
}

// NEW: Stream caching config
const STREAM_CACHE_DIR = process.env.VERCEL ? path.join('/tmp', '.streams_cache') : path.join(__dirname, '.streams_cache');
const STREAM_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const ENABLE_STREAM_CACHE = process.env.DISABLE_STREAM_CACHE !== 'true'; // Enabled by default
console.log(`[addon.js] Stream links caching ${ENABLE_STREAM_CACHE ? 'enabled' : 'disabled'}`);
console.log(`[addon.js] Redis caching ${redis ? 'available' : 'not available'}`);

const { getSoaperTvStreams } = require('./providers/soapertv.js'); // Import from soapertv.js
const { getStreamContent } = require('./providers/vidsrcextractor.js'); // Import from vidsrcextractor.js
const { getVidZeeStreams } = require('./providers/VidZee.js'); // NEW: Import from VidZee.js
const { getMP4HydraStreams } = require('./providers/MP4Hydra.js'); // NEW: Import from MP4Hydra.js
const { getUHDMoviesStreams } = require('./providers/uhdmovies.js'); // NEW: Import from uhdmovies.js
const { getMoviesModStreams } = require('./providers/moviesmod.js'); // NEW: Import from moviesmod.js
const { getTopMoviesStreams } = require('./providers/topmovies.js'); // NEW: Import from topmovies.js
const { getMoviesDriveStreams } = require('./providers/moviesdrive.js'); // NEW: Import from moviesdrive.js
const { get4KHDHubStreams } = require('./providers/4khdhub.js'); // NEW: Import from 4khdhub.js
const { getVixsrcStreams } = require('./providers/vixsrc.js'); // NEW: Import from vixsrc.js
const { getMovieBoxStreams } = require('./providers/moviebox.js'); // NEW: Import from moviebox.js
const axios = require('axios'); // For external provider requests

// Helper function to make requests to external provider services
async function fetchFromExternalProvider(baseUrl, providerName, tmdbId, type, season = null, episode = null) {
    try {
        const endpoint = `/api/streams/${providerName.toLowerCase()}/${tmdbId}`;
        const url = `${baseUrl.replace(/\/$/, '')}${endpoint}`;
        
        // Build query parameters
        const queryParams = new URLSearchParams({ type });
        if (season !== null) queryParams.append('season', season);
        if (episode !== null) queryParams.append('episode', episode);
        
        const fullUrl = `${url}?${queryParams.toString()}`;
        console.log(`[External Provider] Making request to: ${fullUrl}`);
        
        const response = await axios.get(fullUrl, {
            timeout: 30000, // 30 second timeout
            headers: {
                'User-Agent': 'NuvioStreamsAddon/1.0'
            }
        });
        
        if (response.data && response.data.success) {
            return response.data.streams || [];
        } else {
            console.error(`[External Provider] Request failed:`, response.data?.error || 'Unknown error');
            return [];
        }
    } catch (error) {
        console.error(`[External Provider] Error making request to ${baseUrl}/api/streams/${providerName.toLowerCase()}/${tmdbId}:`, error.message);
        return [];
    }
}

// --- Analytics Configuration ---
const GA_MEASUREMENT_ID = process.env.GA_MEASUREMENT_ID;
const GA_API_SECRET = process.env.GA_API_SECRET;
const ANALYTICS_ENABLED = GA_MEASUREMENT_ID && GA_API_SECRET;

if (ANALYTICS_ENABLED) {
    console.log(`[Analytics] GA4 Measurement Protocol is enabled. Tracking to ID: ${GA_MEASUREMENT_ID}`);
} else {
    console.log('[Analytics] GA4 Measurement Protocol is disabled. Set GA_MEASUREMENT_ID and GA_API_SECRET to enable.');
}

// --- Constants ---
const TMDB_API_URL = 'https://api.themoviedb.org/3';
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// Default to proxy/direct mode with Showbox.js
console.log('Using proxy/direct mode with Showbox.js');
const scraper = require('./providers/Showbox.js');

// Destructure the required functions from the selected scraper
const { getStreamsFromTmdbId, convertImdbToTmdb, sortStreamsByQuality } = scraper;

const manifest = require('./manifest.json');

// Initialize the addon
const builder = new addonBuilder(manifest);

// --- Helper Functions ---

// NEW: Helper function to parse quality strings into numerical values
function parseQuality(qualityString) {
    if (!qualityString || typeof qualityString !== 'string') {
        return 0; // Default for unknown or undefined
    }
    const q = qualityString.toLowerCase();

    if (q.includes('4k') || q.includes('2160')) return 2160;
    if (q.includes('1440')) return 1440;
    if (q.includes('1080')) return 1080;
    if (q.includes('720')) return 720;
    if (q.includes('576')) return 576;
    if (q.includes('480')) return 480;
    if (q.includes('360')) return 360;
    if (q.includes('240')) return 240;

    // Handle kbps by extracting number, e.g., "2500k" -> 2.5 (lower than p values)
    const kbpsMatch = q.match(/(\d+)k/);
    if (kbpsMatch && kbpsMatch[1]) {
        return parseInt(kbpsMatch[1], 10) / 1000; // Convert to a small number relative to pixel heights
    }

    if (q.includes('hd')) return 720; // Generic HD
    if (q.includes('sd')) return 480; // Generic SD

    // Lower quality tags
    if (q.includes('cam') || q.includes('camrip')) return 100;
    if (q.includes('ts') || q.includes('telesync')) return 200;
    if (q.includes('scr') || q.includes('screener')) return 300;
    if (q.includes('dvdscr')) return 350;
    if (q.includes('r5') || q.includes('r6')) return 400;

    if (q.includes('org')) return 4320; // Treat original uploads as higher than 4K

    return 0; // Default for anything else not recognized
}

// NEW: Helper function to parse size strings into a number (in MB)
function parseSize(sizeString) {
    if (!sizeString || typeof sizeString !== 'string') {
        return 0;
    }
    const match = sizeString.match(/([0-9.,]+)\s*(GB|MB|KB)/i);
    if (!match) {
        return 0;
    }
    const sizeValue = parseFloat(match[1].replace(/,/g, ''));
    const unit = match[2].toUpperCase();
    if (unit === 'GB') {
        return sizeValue * 1024;
    } else if (unit === 'MB') {
        return sizeValue;
    } else if (unit === 'KB') {
        return sizeValue / 1024;
    }
    return 0;
}

// NEW: Helper function to filter streams by minimum quality
function filterStreamsByQuality(streams, minQualitySetting, providerName) {
    if (!minQualitySetting || minQualitySetting.toLowerCase() === 'all') {
        console.log(`[${providerName}] No minimum quality filter applied (set to 'all' or not specified).`);
        return streams; // No filtering needed
    }

    const minQualityNumeric = parseQuality(minQualitySetting);
    if (minQualityNumeric === 0 && minQualitySetting.toLowerCase() !== 'all') { // Check if minQualitySetting was something unrecognized
        console.warn(`[${providerName}] Minimum quality setting '${minQualitySetting}' was not recognized. No filtering applied.`);
        return streams;
    }

    console.log(`[${providerName}] Filtering streams. Minimum quality: ${minQualitySetting} (Parsed as: ${minQualityNumeric}). Original count: ${streams.length}`);

    const filteredStreams = streams.filter(stream => {
        const streamQualityNumeric = parseQuality(stream.quality);
        return streamQualityNumeric >= minQualityNumeric;
    });

    console.log(`[${providerName}] Filtered count: ${filteredStreams.length}`);
    return filteredStreams;
}

// NEW: Helper function to filter streams by excluding specific codecs
function filterStreamsByCodecs(streams, excludeCodecSettings, providerName) {
    if (!excludeCodecSettings || Object.keys(excludeCodecSettings).length === 0) {
        console.log(`[${providerName}] No codec exclusions applied.`);
        return streams; // No filtering needed
    }

    const excludeDV = excludeCodecSettings.excludeDV === true;
    const excludeHDR = excludeCodecSettings.excludeHDR === true;

    if (!excludeDV && !excludeHDR) {
        console.log(`[${providerName}] No codec exclusions enabled.`);
        return streams;
    }

    console.log(`[${providerName}] Filtering streams. Exclude DV: ${excludeDV}, Exclude HDR: ${excludeHDR}. Original count: ${streams.length}`);

    const filteredStreams = streams.filter(stream => {
        if (!stream.codecs || !Array.isArray(stream.codecs)) {
            return true; // Keep streams without codec information
        }

        // Check for DV exclusion
        if (excludeDV && stream.codecs.includes('DV')) {
            console.log(`[${providerName}] Excluding stream with DV codec: ${stream.title || stream.url}`);
            return false;
        }

        // Check for HDR exclusion (including HDR, HDR10, HDR10+)
        if (excludeHDR && (stream.codecs.includes('HDR') || stream.codecs.includes('HDR10') || stream.codecs.includes('HDR10+'))) {
            console.log(`[${providerName}] Excluding stream with HDR codec: ${stream.title || stream.url}`);
            return false;
        }

        return true; // Keep the stream
    });

    console.log(`[${providerName}] After codec filtering count: ${filteredStreams.length}`);
    return filteredStreams;
}

// NEW: Helper function that combines both quality and codec filtering
function applyAllStreamFilters(streams, providerName, minQualitySetting, excludeCodecSettings) {
    // Apply quality filtering first
    let filteredStreams = filterStreamsByQuality(streams, minQualitySetting, providerName);
    // Then apply codec filtering
    filteredStreams = filterStreamsByCodecs(filteredStreams, excludeCodecSettings, providerName);
    return filteredStreams;
}

async function fetchWithRetry(url, options, maxRetries = MAX_RETRIES) {
    const { default: fetchFunction } = await import('node-fetch'); // Dynamically import
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetchFunction(url, options); // Use the dynamically imported function
            if (!response.ok) {
                let errorBody = '';
                try {
                    errorBody = await response.text();
                } catch (e) { /* ignore */ }
                throw new Error(`HTTP error! Status: ${response.status} ${response.statusText}. Body: ${errorBody.substring(0, 200)}`);
            }
            return response;
        } catch (error) {
            lastError = error;
            console.warn(`Fetch attempt ${attempt}/${maxRetries} failed for ${url}: ${error.message}`);
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * Math.pow(2, attempt - 1)));
            }
        }
    }
    console.error(`All fetch attempts failed for ${url}. Last error:`, lastError.message);
    throw lastError;
}

// --- NEW: Google Analytics Event Sending Function ---
async function sendAnalyticsEvent(eventName, eventParams) {
    if (!ANALYTICS_ENABLED) {
        return;
    }

    // Use a dynamically generated client_id for each event to ensure anonymity
    const clientId = crypto.randomBytes(16).toString("hex");

    const analyticsData = {
        client_id: clientId,
        events: [{
            name: eventName,
            params: {
                // GA4 standard parameters for better reporting
                session_id: crypto.randomBytes(16).toString("hex"),
                engagement_time_msec: '100',
                ...eventParams
            },
        }],
    };

    try {
        const { default: fetchFunction } = await import('node-fetch');
        // Use a proper timeout and catch any network errors to prevent crashes
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000); // 5 second timeout
        
        // Fire-and-forget with proper error handling
        fetchFunction(`https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`, {
            method: 'POST',
            body: JSON.stringify(analyticsData),
            signal: controller.signal
        }).catch(err => {
            console.warn(`[Analytics] Network error sending event: ${err.message}`);
        }).finally(() => {
            clearTimeout(timeout);
        });
        
        console.log(`[Analytics] Sent event: ${eventName} for "${eventParams.content_title || 'N/A'}"`);
    } catch (error) {
        console.warn(`[Analytics] Failed to send event: ${error.message}`);
    }
}

// Helper function for fetching with a timeout
function fetchWithTimeout(promise, timeoutMs, providerName) {
  return new Promise((resolve) => { // Always resolve to prevent Promise.all from rejecting
    let timer = null;

    const timeoutPromise = new Promise(r => {
      timer = setTimeout(() => {
        console.log(`[${providerName}] Request timed out after ${timeoutMs}ms. Returning empty array.`);
        r({ streams: [], provider: providerName, error: new Error('Timeout') }); // Resolve with an object indicating timeout
      }, timeoutMs);
    });

    Promise.race([promise, timeoutPromise])
      .then((result) => {
        clearTimeout(timer);
        // Ensure the result is an object with a streams array, even if the original promise resolved with just an array
        if (Array.isArray(result)) {
          resolve({ streams: result, provider: providerName });
        } else if (result && typeof result.streams !== 'undefined') {
          resolve(result); // Already in the expected format (e.g. from timeoutPromise)
        } else {
          // This case might happen if the promise resolves with something unexpected
          console.warn(`[${providerName}] Resolved with unexpected format. Returning empty array. Result:`, result);
          resolve({ streams: [], provider: providerName });
        }
      })
      .catch(error => {
        clearTimeout(timer);
        console.error(`[${providerName}] Error fetching streams: ${error.message}. Returning empty array.`);
        resolve({ streams: [], provider: providerName, error }); // Resolve with an object indicating error
      });
  });
}

// Define function to get streams from VidSrc
async function getVidSrcStreams(tmdbId, mediaType, seasonNum = null, episodeNum = null) {
    try {
        console.log(`[VidSrc] Attempting to fetch streams for TMDB ID: ${tmdbId}, Type: ${mediaType}, Season: ${seasonNum}, Episode: ${episodeNum}`);
        
        // Convert TMDB ID to IMDb ID for VidSrc
        // This is a simplified example - you might need to implement proper TMDB to IMDb conversion
        // For now, assuming we have access to the IMDb ID from the caller
        let imdbId;
        if (tmdbId.startsWith('tt')) {
            imdbId = tmdbId; // Already an IMDb ID
        } else {
            // You would need to implement this conversion
            // For example, using the convertTmdbToImdb function if available
            // imdbId = await convertTmdbToImdb(tmdbId, mediaType);
            console.log(`[VidSrc] TMDB ID conversion not implemented yet. Skipping...`);
            return [];
        }
        
        // Format the ID according to VidSrc requirements
        let vidsrcId;
        if (mediaType === 'movie') {
            vidsrcId = imdbId;
        } else if (mediaType === 'tv' && seasonNum !== null && episodeNum !== null) {
            vidsrcId = `${imdbId}:${seasonNum}:${episodeNum}`;
        } else {
            console.log(`[VidSrc] Invalid parameters for TV show. Need season and episode numbers.`);
            return [];
        }
        
        // Call the getStreamContent function from vidsrcextractor.js
        const typeForVidSrc = mediaType === 'movie' ? 'movie' : 'series';
        const results = await getStreamContent(vidsrcId, typeForVidSrc);
        
        if (!results || results.length === 0) {
            console.log(`[VidSrc] No streams found for ${vidsrcId}.`);
            return [];
        }
        
        // Process the results into the standard stream format
        const streams = [];
        
        for (const result of results) {
            if (result.streams && result.streams.length > 0) {
                for (const streamInfo of result.streams) {
                    const quality = streamInfo.quality.includes('x') 
                        ? streamInfo.quality.split('x')[1] + 'p' // Convert "1280x720" to "720p"
                        : streamInfo.quality; // Keep as is for kbps or unknown
                    
                    streams.push({
                        title: result.name || "VidSrc Stream",
                        url: streamInfo.url,
                        quality: quality,
                        provider: "VidSrc",
                        // You can add additional metadata if needed
                        size: "Unknown size",
                        languages: ["Unknown"],
                        subtitles: [],
                        // If the referer is needed for playback
                        headers: result.referer ? { referer: result.referer } : undefined
                    });
                }
            }
        }
        
        console.log(`[VidSrc] Successfully extracted ${streams.length} streams.`);
        return streams;
    } catch (error) {
        console.error(`[VidSrc] Error fetching streams:`, error.message);
        return [];
    }
}

// --- Stream Caching Functions ---
// Ensure stream cache directory exists
const ensureStreamCacheDir = async () => {
    if (!ENABLE_STREAM_CACHE) return;
    
    try {
        await fs.mkdir(STREAM_CACHE_DIR, { recursive: true });
        console.log(`[Stream Cache] Cache directory ensured at ${STREAM_CACHE_DIR}`);
    } catch (error) {
        if (error.code !== 'EEXIST') {
            console.warn(`[Stream Cache] Warning: Could not create cache directory ${STREAM_CACHE_DIR}: ${error.message}`);
        }
    }
};

// Initialize stream cache directory on startup
ensureStreamCacheDir().catch(err => console.error(`[Stream Cache] Error creating cache directory: ${err.message}`));

// Generate cache key for a provider's streams
const getStreamCacheKey = (provider, type, id, seasonNum = null, episodeNum = null, region = null, cookie = null) => {
    // Basic key parts
    let key = `streams_${provider}_${type}_${id}`;
    
    // Add season/episode for TV series
    if (seasonNum !== null && episodeNum !== null) {
        key += `_s${seasonNum}e${episodeNum}`;
    }
    
    // For ShowBox with custom cookie/region, add those to the cache key
    if (provider.toLowerCase() === 'showbox' && (region || cookie)) {
        key += '_custom';
        if (region) key += `_${region}`;
        if (cookie) {
            // Hash the cookie to avoid storing sensitive info in filenames
            const cookieHash = crypto.createHash('md5').update(cookie).digest('hex').substring(0, 10);
            key += `_${cookieHash}`;
        }
    }
    
    return key;
};

// Get cached streams for a provider - Hybrid approach (Redis first, then file)
const getStreamFromCache = async (provider, type, id, seasonNum = null, episodeNum = null, region = null, cookie = null) => {
    if (!ENABLE_STREAM_CACHE) return null;
    // Exclude ShowBox and PStream from cache entirely
    try {
        if (provider && ['showbox', 'pstream'].includes(String(provider).toLowerCase())) {
            return null;
        }
    } catch (_) {}
    
    const cacheKey = getStreamCacheKey(provider, type, id, seasonNum, episodeNum, region, cookie);
    
    // Try Redis first if available
    if (redis) {
        try {
            const data = await redis.get(cacheKey);
            if (data) {
                const cached = JSON.parse(data);
                
                // Check if cache is expired (redundant with Redis TTL, but for safety)
                if (cached.expiry && Date.now() > cached.expiry) {
                    console.log(`[Redis Cache] EXPIRED for ${provider}: ${cacheKey}`);
                    await redis.del(cacheKey);
                    return null;
                }
                
                // Check for failed status - retry on next request
                if (cached.status === 'failed') {
                    console.log(`[Redis Cache] RETRY for previously failed ${provider}: ${cacheKey}`);
                    return null;
                }
                
                console.log(`[Redis Cache] HIT for ${provider}: ${cacheKey}`);
                return cached.streams;
            }
        } catch (error) {
            console.warn(`[Redis Cache] READ ERROR for ${provider}: ${cacheKey}: ${error.message}`);
            console.log('[Redis Cache] Falling back to file cache');
            // Fall back to file cache on Redis error
        }
    }
    
    // File cache fallback
    const fileCacheKey = cacheKey + '.json';
    const cachePath = path.join(STREAM_CACHE_DIR, fileCacheKey);
    
    try {
        const data = await fs.readFile(cachePath, 'utf-8');
        const cached = JSON.parse(data);
        
        // Check if cache is expired
        if (cached.expiry && Date.now() > cached.expiry) {
            console.log(`[File Cache] EXPIRED for ${provider}: ${fileCacheKey}`);
            await fs.unlink(cachePath).catch(() => {}); // Delete expired cache
            return null;
        }
        
        // Check for failed status - retry on next request
        if (cached.status === 'failed') {
            console.log(`[File Cache] RETRY for previously failed ${provider}: ${fileCacheKey}`);
            return null;
        }
        
        console.log(`[File Cache] HIT for ${provider}: ${fileCacheKey}`);
        return cached.streams;
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn(`[File Cache] READ ERROR for ${provider}: ${fileCacheKey}: ${error.message}`);
        }
        return null;
    }
};

// Save streams to cache - Hybrid approach (Redis + file)
const saveStreamToCache = async (provider, type, id, streams, status = 'ok', seasonNum = null, episodeNum = null, region = null, cookie = null, ttlMs = null) => {
    if (!ENABLE_STREAM_CACHE) return;
    // Exclude ShowBox and PStream from cache entirely
    try {
        if (provider && ['showbox', 'pstream'].includes(String(provider).toLowerCase())) {
            return;
        }
    } catch (_) {}
    
    const cacheKey = getStreamCacheKey(provider, type, id, seasonNum, episodeNum, region, cookie);
    const effectiveTtlMs = ttlMs !== null ? ttlMs : STREAM_CACHE_TTL_MS; // Use provided TTL or default

    const cacheData = {
        streams: streams,
        status: status,
        expiry: Date.now() + effectiveTtlMs, // Use effective TTL
        timestamp: Date.now()
    };
    
    let redisSuccess = false;
    
    // Try Redis first if available
    if (redis) {
        try {
            // PX sets expiry in milliseconds
            await redis.set(cacheKey, JSON.stringify(cacheData), 'PX', effectiveTtlMs); // Use effective TTL
            console.log(`[Redis Cache] SAVED for ${provider}: ${cacheKey} (${streams.length} streams, status: ${status}, TTL: ${effectiveTtlMs / 1000}s)`);
            redisSuccess = true;
        } catch (error) {
            console.warn(`[Redis Cache] WRITE ERROR for ${provider}: ${cacheKey}: ${error.message}`);
            console.log('[Redis Cache] Falling back to file cache');
        }
    }
    
    // Also save to file cache as backup, or if Redis failed
    try {
        const fileCacheKey = cacheKey + '.json';
        const cachePath = path.join(STREAM_CACHE_DIR, fileCacheKey);
        await fs.writeFile(cachePath, JSON.stringify(cacheData), 'utf-8');
        
        // Only log if Redis didn't succeed to avoid redundant logging
        if (!redisSuccess) {
            console.log(`[File Cache] SAVED for ${provider}: ${fileCacheKey} (${streams.length} streams, status: ${status}, TTL: ${effectiveTtlMs / 1000}s)`);
        }
    } catch (error) {
        console.warn(`[File Cache] WRITE ERROR for ${provider}: ${cacheKey}.json: ${error.message}`);
    }
};

// Define stream handler for movies
builder.defineStreamHandler(async (args) => {
    const requestStartTime = Date.now(); // Start total request timer
    const providerTimings = {}; // Object to store timings

    const formatDuration = (ms) => {
        if (ms < 1000) {
            return `${ms}ms`;
        }
        const totalSeconds = ms / 1000;
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        
        let str = "";
        if (minutes > 0) {
            str += `${minutes}m `;
        }
        
        if (seconds > 0 || minutes === 0) {
            let secStr = seconds.toFixed(2);
            if (secStr.endsWith('.00')) {
                secStr = secStr.substring(0, secStr.length - 3);
            }
            str += `${secStr}s`;
        }
        
        return str.trim();
    };

    const { type, id, config: sdkConfig } = args;

    // Read config from global set by server.js middleware
    const requestSpecificConfig = global.currentRequestConfig || {};
    // Mask sensitive fields for logs
    const maskedForLog = (() => {
        try {
            const clone = JSON.parse(JSON.stringify(requestSpecificConfig));
            if (clone.cookie) clone.cookie = '[PRESENT: ****]';
            if (clone.cookies && Array.isArray(clone.cookies)) clone.cookies = `[${clone.cookies.length} cookies]`;
            if (clone.scraper_api_key) clone.scraper_api_key = '[PRESENT: ****]';
            if (clone.chosenFebboxBaseCookieForRequest) clone.chosenFebboxBaseCookieForRequest = '[PRESENT: ****]';
            return clone;
        } catch (_) {
            return { masked: true };
        }
    })();
    console.log(`[addon.js] Read from global.currentRequestConfig: ${JSON.stringify(maskedForLog)}`);

    // NEW: Get minimum quality preferences
    const minQualitiesPreferences = requestSpecificConfig.minQualities || {};
    if (Object.keys(minQualitiesPreferences).length > 0) {
        console.log(`[addon.js] Minimum quality preferences: ${JSON.stringify(minQualitiesPreferences)}`);
    } else {
        console.log(`[addon.js] No minimum quality preferences set by user.`);
    }

    // NEW: Get codec exclude preferences
    const excludeCodecsPreferences = requestSpecificConfig.excludeCodecs || {};
    if (Object.keys(excludeCodecsPreferences).length > 0) {
        console.log(`[addon.js] Codec exclude preferences: ${JSON.stringify(excludeCodecsPreferences)}`);
    } else {
        console.log(`[addon.js] No codec exclude preferences set by user.`);
    }

    console.log("--- FULL ARGS OBJECT (from SDK) ---");
    console.log(JSON.stringify(args, null, 2));
    console.log("--- SDK ARGS.CONFIG (still logging for comparison) ---");
    console.log(JSON.stringify(sdkConfig, null, 2)); // Log the original sdkConfig
    console.log("---------------------------------");

    // Helper to get flag emoji from URL hostname
    const getFlagEmojiForUrl = (url) => {
        try {
            const hostname = new URL(url).hostname;
            // Match common patterns like xx, xxN, xxNN at the start of a part of the hostname
            const match = hostname.match(/^([a-zA-Z]{2,3})[0-9]{0,2}(?:[.-]|$)/i);
            if (match && match[1]) {
                const countryCode = match[1].toLowerCase();
                const flagMap = {
                    'us': '🇺🇸', 'usa': '🇺🇸',
                    'gb': '🇬🇧', 'uk': '🇬🇧',
                    'ca': '🇨🇦',
                    'de': '🇩🇪',
                    'fr': '🇫🇷',
                    'nl': '🇳🇱',
                    'hk': '🇭🇰',
                    'sg': '🇸🇬',
                    'jp': '🇯🇵',
                    'au': '🇦🇺',
                    'in': '🇮🇳',
                    // Add more as needed
                };
                return flagMap[countryCode] || ''; // Return empty string if no match
            }
        } catch (e) {
            // Invalid URL or other error
        }
        return ''; // Default to empty string
    };

    // Use values from requestSpecificConfig (derived from global)
    let userRegionPreference = requestSpecificConfig.region || null;
    let userCookie = requestSpecificConfig.cookie || null; // Already decoded by server.js
    let userScraperApiKey = requestSpecificConfig.scraper_api_key || null; // NEW: Get ScraperAPI Key
    
    // Combine single cookie + cookies array into unified list for ShowBox
    // This ensures both single cookie and multi-cookie setups work
    const cookiesFromArray = Array.isArray(requestSpecificConfig.cookies) ? requestSpecificConfig.cookies : [];
    const allCookies = [];
    
    // Add single cookie first (priority)
    if (userCookie && userCookie.trim()) {
        allCookies.push(userCookie.trim());
    }
    
    // Add cookies from array (deduplicate)
    for (const c of cookiesFromArray) {
        if (c && c.trim() && !allCookies.includes(c.trim())) {
            allCookies.push(c.trim());
        }
    }
    
    if (allCookies.length > 0) {
        console.log(`[addon.js] Combined ${allCookies.length} unique cookie(s) for ShowBox`);
    }
    
    // Log the request information in a more detailed way
    console.log(`Stream request for Stremio type: '${type}', id: '${id}'`);
    
    let selectedProvidersArray = null;
    if (requestSpecificConfig.providers) {
        selectedProvidersArray = requestSpecificConfig.providers.split(',').map(p => p.trim().toLowerCase());
    }
    
    // Detect presence of cookies (single or array)
    const hasCookiesArray = cookiesFromArray.length > 0;
    const hasAnyCookies = allCookies.length > 0;
    console.log(`Effective request details: ${JSON.stringify({
        regionPreference: userRegionPreference || 'none',
        hasCookie: hasAnyCookies,
        cookieCount: allCookies.length,
        selectedProviders: selectedProvidersArray ? selectedProvidersArray.join(', ') : 'all'
    })}`);
    
    if (userRegionPreference) {
        console.log(`[addon.js] Using region from global config: ${userRegionPreference}`);
    } else {
        console.log(`[addon.js] No region preference found in global config.`);
    }
    
    if (hasAnyCookies) {
        const cookieSource = userCookie ? 'single' : 'array';
        console.log(`[addon.js] Using personal cookie(s): ${allCookies.length} cookie(s) available (source: ${cookieSource})`);
    } else {
        console.log(`[addon.js] No cookie found in global config.`);
    }

    if (selectedProvidersArray) {
        console.log(`[addon.js] Using providers from global config: ${selectedProvidersArray.join(', ')}`);
    } else {
        console.log('[addon.js] No specific providers selected by user in global config, will attempt all.');
    }

    if (type !== 'movie' && type !== 'series' && type !== 'tv') {
        return { streams: [] };
    }
    
    let tmdbId;
    let tmdbTypeFromId;
    let seasonNum = null;
    let episodeNum = null;
    let initialTitleFromConversion = null;
    let isAnimation = false; // <--- New flag to track if content is animation
    
    const idParts = id.split(':');
    
    if (idParts[0] === 'tmdb') {
        tmdbId = idParts[1];
        tmdbTypeFromId = type === 'movie' ? 'movie' : 'tv';
        console.log(`  Received TMDB ID directly: ${tmdbId} for type ${tmdbTypeFromId}`);
        
        // Check for season and episode
        if (idParts.length >= 4 && (type === 'series' || type === 'tv')) {
            seasonNum = parseInt(idParts[2], 10);
            episodeNum = parseInt(idParts[3], 10);
            console.log(`  Parsed season ${seasonNum}, episode ${episodeNum} from Stremio ID`);
        }
    } else if (id.startsWith('tt')) {
        console.log(`  Received IMDb ID: ${id}. Attempting to convert to TMDB ID.`);
        
        const imdbParts = id.split(':');
        let baseImdbId = id; // Default to full ID for movies

        if (imdbParts.length >= 3 && (type === 'series' || type === 'tv')) {
            seasonNum = parseInt(imdbParts[1], 10);
            episodeNum = parseInt(imdbParts[2], 10);
            baseImdbId = imdbParts[0]; // Use only the IMDb ID part for conversion
            console.log(`  Parsed season ${seasonNum}, episode ${episodeNum} from IMDb ID parts`);
        }
        
        // Pass userRegionPreference and expected type to convertImdbToTmdb
        const conversionResult = await convertImdbToTmdb(baseImdbId, userRegionPreference, type);
        if (conversionResult && conversionResult.tmdbId && conversionResult.tmdbType) {
            tmdbId = conversionResult.tmdbId;
            tmdbTypeFromId = conversionResult.tmdbType;
            initialTitleFromConversion = conversionResult.title; // Capture title from conversion
            console.log(`  Successfully converted IMDb ID ${baseImdbId} to TMDB ${tmdbTypeFromId} ID ${tmdbId} (${initialTitleFromConversion || 'No title returned'})`);
        } else {
            console.log(`  Failed to convert IMDb ID ${baseImdbId} to TMDB ID.`);
            return { streams: [] };
        }
    } else {
        console.log(`  Unrecognized ID format: ${id}`);
        return { streams: [] };
    }
    
    if (!tmdbId || !tmdbTypeFromId) {
        console.log('  Could not determine TMDB ID or type after processing Stremio ID.');
        return { streams: [] };
    }

    let movieOrSeriesTitle = initialTitleFromConversion;
    let movieOrSeriesYear = null;
    let seasonTitle = null;

    if (tmdbId && TMDB_API_KEY) {
        try {
            let detailsUrl;
            if (tmdbTypeFromId === 'movie') {
                detailsUrl = `${TMDB_API_URL}/movie/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`;
            } else { // 'tv'
                detailsUrl = `${TMDB_API_URL}/tv/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`;
            }
            
            console.log(`Fetching details from TMDB: ${detailsUrl}`);
            const tmdbDetailsResponse = await fetchWithRetry(detailsUrl, {});
            if (!tmdbDetailsResponse.ok) throw new Error(`TMDB API error: ${tmdbDetailsResponse.status}`);
            const tmdbDetails = await tmdbDetailsResponse.json();

            if (tmdbTypeFromId === 'movie') {
                if (!movieOrSeriesTitle) movieOrSeriesTitle = tmdbDetails.title;
                movieOrSeriesYear = tmdbDetails.release_date ? tmdbDetails.release_date.substring(0, 4) : null;
            } else { // 'tv'
                if (!movieOrSeriesTitle) movieOrSeriesTitle = tmdbDetails.name;
                movieOrSeriesYear = tmdbDetails.first_air_date ? tmdbDetails.first_air_date.substring(0, 4) : null;
            }
            console.log(`  Fetched/Confirmed TMDB details: Title='${movieOrSeriesTitle}', Year='${movieOrSeriesYear}'`);

            // NEW: Fetch season-specific title for TV shows
            if (tmdbTypeFromId === 'tv' && seasonNum) {
                const seasonDetailsUrl = `${TMDB_API_URL}/tv/${tmdbId}/season/${seasonNum}?api_key=${TMDB_API_KEY}&language=en-US`;
                console.log(`Fetching season details from TMDB: ${seasonDetailsUrl}`);
                try {
                    const seasonDetailsResponse = await fetchWithRetry(seasonDetailsUrl, {});
                    if (seasonDetailsResponse.ok) {
                        const seasonDetails = await seasonDetailsResponse.json();
                        seasonTitle = seasonDetails.name;
                        console.log(`  Fetched season title: "${seasonTitle}"`);
                    }
                } catch (e) {
                    console.warn(`Could not fetch season-specific title: ${e.message}`);
                }
            }

            // Check for Animation genre
            if (tmdbDetails.genres && Array.isArray(tmdbDetails.genres)) {
                if (tmdbDetails.genres.some(genre => genre.name.toLowerCase() === 'animation')) {
                    isAnimation = true;
                    console.log('  Content identified as Animation based on TMDB genres.');
                }
            }

        } catch (e) {
            console.error(`  Error fetching details from TMDB: ${e.message}`);
        }
    } else if (tmdbId && !TMDB_API_KEY) {
        console.warn("TMDB_API_KEY is not configured. Cannot fetch full title/year/genres.");
    }
    
    // --- Send Analytics Event ---
    if (movieOrSeriesTitle) {
        sendAnalyticsEvent('stream_request', {
            content_type: tmdbTypeFromId,
            content_id: tmdbId,
            content_title: movieOrSeriesTitle,
            content_year: movieOrSeriesYear || 'N/A',
            selected_providers: selectedProvidersArray ? selectedProvidersArray.join(',') : 'all',
            // Custom dimension for tracking if it's an animation
            is_animation: isAnimation ? 'true' : 'false', 
        });
    }

    let combinedRawStreams = [];

    // --- Provider Selection Logic ---
    const shouldFetch = (providerId) => {
        if (!selectedProvidersArray) return true; // If no selection, fetch all
        return selectedProvidersArray.includes(providerId.toLowerCase());
    };

    // Helper for timing provider fetches
    const timeProvider = async (providerName, fetchPromise) => {
        const startTime = Date.now();
        const result = await fetchPromise;
        const endTime = Date.now();
        providerTimings[providerName] = formatDuration(endTime - startTime);
        return result;
    };

    // --- NEW: Asynchronous provider fetching with caching ---
    console.log('[Stream Cache] Checking cache for all enabled providers...');
    
    const providerFetchFunctions = {
        // ShowBox provider with cache integration
        showbox: async () => {
            if (!shouldFetch('showbox')) {
                console.log('[ShowBox] Skipping fetch: Not selected by user.');
                return [];
            }
            
            // Try to get cached streams first
            const cachedStreams = await getStreamFromCache('showbox', tmdbTypeFromId, tmdbId, seasonNum, episodeNum, userRegionPreference, userCookie);
            if (cachedStreams) {
                console.log(`[ShowBox] Using ${cachedStreams.length} streams from cache.`);
                return cachedStreams.map(stream => {
                    // Preserve original provider information for cached streams too
                    if (stream.provider === 'PStream') {
                        return stream; // Keep PStream provider as-is
                    } else {
                        return { ...stream, provider: 'ShowBox' }; // Set ShowBox for other streams
                    }
                });
            }
            
            // No cache or expired, fetch fresh with retry mechanism
            console.log(`[ShowBox] Fetching new streams...`);
            let lastError = null;
            const MAX_SHOWBOX_RETRIES = 3;
            
            // Retry logic for ShowBox
            for (let attempt = 1; attempt <= MAX_SHOWBOX_RETRIES; attempt++) {
                try {
                    console.log(`[ShowBox] Attempt ${attempt}/${MAX_SHOWBOX_RETRIES}`);
                    // Pass allCookies array to ShowBox - it will select the best cookie with fallback
                    const streams = await getStreamsFromTmdbId(tmdbTypeFromId, tmdbId, seasonNum, episodeNum, userRegionPreference, allCookies, userScraperApiKey);
                    
            if (streams && streams.length > 0) {
                        console.log(`[ShowBox] Successfully fetched ${streams.length} streams on attempt ${attempt}.`);
                        // Save to cache with success status
                        await saveStreamToCache('showbox', tmdbTypeFromId, tmdbId, streams, 'ok', seasonNum, episodeNum, userRegionPreference, userCookie);
                        // Preserve original provider information - don't override PStream streams
                        return streams.map(stream => {
                            // Only set provider to 'ShowBox' if it's not already set to 'PStream'
                            if (stream.provider === 'PStream') {
                                return stream; // Keep PStream provider as-is
                            } else {
                                return { ...stream, provider: 'ShowBox' }; // Set ShowBox for other streams
                            }
                        });
                    } else {
                        console.log(`[ShowBox] No streams returned for TMDB ${tmdbTypeFromId}/${tmdbId} on attempt ${attempt}`);
                        // Only save empty result if we're on the last retry
                        if (attempt === MAX_SHOWBOX_RETRIES) {
                            await saveStreamToCache('showbox', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum, userRegionPreference, userCookie);
                        }
                        // If not last attempt, wait and retry
                        if (attempt < MAX_SHOWBOX_RETRIES) {
                            const delayMs = 1000 * Math.pow(2, attempt - 1); // Exponential backoff: 1s, 2s, 4s
                            console.log(`[ShowBox] Waiting ${delayMs}ms before retry...`);
                            await new Promise(resolve => setTimeout(resolve, delayMs));
                        }
                    }
                } catch (err) {
                    lastError = err;
                    console.error(`[ShowBox] Error fetching streams (attempt ${attempt}/${MAX_SHOWBOX_RETRIES}):`, err.message);
                    
                    // If not last attempt, wait and retry
                    if (attempt < MAX_SHOWBOX_RETRIES) {
                        const delayMs = 1000 * Math.pow(2, attempt - 1); // Exponential backoff: 1s, 2s, 4s
                        console.log(`[ShowBox] Waiting ${delayMs}ms before retry...`);
                        await new Promise(resolve => setTimeout(resolve, delayMs));
                    } else {
                        // Only save error status to cache on the last retry
                        await saveStreamToCache('showbox', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum, userRegionPreference, userCookie);
                    }
                }
            }
            
            // If we get here, all retries failed
            console.error(`[ShowBox] All ${MAX_SHOWBOX_RETRIES} attempts failed. Last error: ${lastError ? lastError.message : 'Unknown error'}`);
            return [];
        },
        
        // (Removed) Xprime provider

        // (Removed) HollyMovieHD provider

        // SoaperTV provider with cache integration
        soapertv: async () => {
            if (!ENABLE_SOAPERTV_PROVIDER) {
                console.log('[SoaperTV] Skipping fetch: Disabled by environment variable.');
                return [];
            }
            if (!shouldFetch('soapertv')) {
                console.log('[SoaperTV] Skipping fetch: Not selected by user.');
                return [];
            }
            
            // Try to get cached streams first
            const cachedStreams = await getStreamFromCache('soapertv', tmdbTypeFromId, tmdbId, seasonNum, episodeNum);
            if (cachedStreams) {
                console.log(`[SoaperTV] Using ${cachedStreams.length} streams from cache.`);
                return cachedStreams.map(stream => ({ ...stream, provider: 'Soaper TV' }));
    }
    
            // No cache or expired, fetch fresh
            try {
                console.log(`[SoaperTV] Fetching new streams...`);
                const streams = await getSoaperTvStreams(tmdbId, tmdbTypeFromId, seasonNum, episodeNum);
                
                if (streams && streams.length > 0) {
                    console.log(`[SoaperTV] Successfully fetched ${streams.length} streams.`);
                    // Save to cache
                    await saveStreamToCache('soapertv', tmdbTypeFromId, tmdbId, streams, 'ok', seasonNum, episodeNum);
                    return streams.map(stream => ({ ...stream, provider: 'Soaper TV' }));
    } else {
                    console.log(`[SoaperTV] No streams returned.`);
                    // Save empty result
                    await saveStreamToCache('soapertv', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                    return [];
                }
            } catch (err) {
                console.error(`[SoaperTV] Error fetching streams:`, err.message);
                // Save error status to cache
                await saveStreamToCache('soapertv', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                return [];
            }
        },

        // (Removed) Cuevana provider

        // (Removed) Hianime provider

        // VidSrc provider with cache integration
        vidsrc: async () => {
            if (!shouldFetch('vidsrc')) {
                console.log('[VidSrc] Skipping fetch: Not selected by user.');
                    return [];
            }
            
            // Try to get cached streams first
            const cachedStreams = await getStreamFromCache('vidsrc', tmdbTypeFromId, tmdbId, seasonNum, episodeNum);
            if (cachedStreams) {
                console.log(`[VidSrc] Using ${cachedStreams.length} streams from cache.`);
                return cachedStreams.map(stream => ({ ...stream, provider: 'VidSrc' }));
    }
    
            // No cache or expired, fetch fresh
        try {
                console.log(`[VidSrc] Fetching new streams...`);
                const streams = await getVidSrcStreams(
                id.startsWith('tt') ? id.split(':')[0] : tmdbId, 
                tmdbTypeFromId, 
                seasonNum, 
                episodeNum
            );
            
                if (streams && streams.length > 0) {
                    console.log(`[VidSrc] Successfully fetched ${streams.length} streams.`);
                    // Save to cache
                    await saveStreamToCache('vidsrc', tmdbTypeFromId, tmdbId, streams, 'ok', seasonNum, episodeNum);
                    return streams.map(stream => ({ ...stream, provider: 'VidSrc' }));
                } else {
                    console.log(`[VidSrc] No streams returned.`);
                    // Save empty result
                    await saveStreamToCache('vidsrc', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
            return [];
                }
        } catch (err) {
                console.error(`[VidSrc] Error fetching streams:`, err.message);
                // Save error status to cache
                await saveStreamToCache('vidsrc', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
            return [];
        }
        },

        // VidZee provider with cache integration
        vidzee: async () => {
            if (!ENABLE_VIDZEE_PROVIDER) { // Check if VidZee is globally disabled
                console.log('[VidZee] Skipping fetch: Disabled by environment variable.');
                return [];
            }
            if (!shouldFetch('vidzee')) {
                console.log('[VidZee] Skipping fetch: Not selected by user.');
                return [];
            }
            
            // Try to get cached streams first
            const cachedStreams = await getStreamFromCache('vidzee', tmdbTypeFromId, tmdbId, seasonNum, episodeNum, null, null);
            if (cachedStreams) {
                console.log(`[VidZee] Using ${cachedStreams.length} streams from cache.`);
                return cachedStreams.map(stream => ({ ...stream, provider: 'VidZee' }));
            }
            
            // No cache or expired, fetch fresh
            try {
                console.log(`[VidZee] Fetching new streams...`);
                const streams = await getVidZeeStreams(tmdbId, tmdbTypeFromId, seasonNum, episodeNum);
                
                if (streams && streams.length > 0) {
                    console.log(`[VidZee] Successfully fetched ${streams.length} streams.`);
                    // Save to cache
                    await saveStreamToCache('vidzee', tmdbTypeFromId, tmdbId, streams, 'ok', seasonNum, episodeNum, null, null);
                    return streams.map(stream => ({ ...stream, provider: 'VidZee' }));
                } else {
                    console.log(`[VidZee] No streams returned.`);
                    // Save empty result
                    await saveStreamToCache('vidzee', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum, null, null);
                    return [];
                }
            } catch (err) {
                console.error(`[VidZee] Error fetching streams:`, err.message);
                // Save error status to cache
                await saveStreamToCache('vidzee', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum, null, null);
                return [];
            }
        },

        // MP4Hydra provider with cache integration
        mp4hydra: async () => {
            if (!ENABLE_MP4HYDRA_PROVIDER) { // Check if MP4Hydra is disabled
                console.log('[MP4Hydra] Skipping fetch: Disabled by environment variable.');
                return [];
            }
            if (!shouldFetch('mp4hydra')) {
                console.log('[MP4Hydra] Skipping fetch: Not selected by user.');
                return [];
            }
            
            // Try to get cached streams first
            const cachedStreams = await getStreamFromCache('mp4hydra', tmdbTypeFromId, tmdbId, seasonNum, episodeNum);
            if (cachedStreams) {
                console.log(`[MP4Hydra] Using ${cachedStreams.length} streams from cache.`);
                return cachedStreams.map(stream => ({ ...stream, provider: 'MP4Hydra' }));
            }
            
            // No cache or expired, fetch fresh
            try {
                console.log(`[MP4Hydra] Fetching new streams...`);
                const streams = await getMP4HydraStreams(tmdbId, tmdbTypeFromId, seasonNum, episodeNum);
                
                if (streams && streams.length > 0) {
                    console.log(`[MP4Hydra] Successfully fetched ${streams.length} streams.`);
                    // Save to cache
                    await saveStreamToCache('mp4hydra', tmdbTypeFromId, tmdbId, streams, 'ok', seasonNum, episodeNum);
                    return streams.map(stream => ({ ...stream, provider: 'MP4Hydra' }));
                } else {
                    console.log(`[MP4Hydra] No streams returned.`);
                    // Save empty result
                    await saveStreamToCache('mp4hydra', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                    return [];
                }
            } catch (err) {
                console.error(`[MP4Hydra] Error fetching streams:`, err.message);
                // Save error status to cache
                await saveStreamToCache('mp4hydra', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                return [];
            }
        },

        // UHDMovies provider with cache integration
        uhdmovies: async () => {
            if (!ENABLE_UHDMOVIES_PROVIDER) {
                console.log('[UHDMovies] Skipping fetch: Disabled by environment variable.');
                return [];
            }
            if (!shouldFetch('uhdmovies')) {
                console.log('[UHDMovies] Skipping fetch: Not selected by user.');
                return [];
            }
            
            // Try to get cached streams first
            const cachedStreams = await getStreamFromCache('uhdmovies', tmdbTypeFromId, tmdbId, seasonNum, episodeNum);
            if (cachedStreams) {
                console.log(`[UHDMovies] Using ${cachedStreams.length} streams from cache.`);
                return cachedStreams.map(stream => ({ ...stream, provider: 'UHDMovies' }));
            }
            
            // No cache or expired, fetch fresh
            try {
                console.log(`[UHDMovies] Fetching new streams...`);
                let streams;
                
                // Check if external service URL is configured
                if (EXTERNAL_UHDMOVIES_URL) {
                    console.log(`[UHDMovies] Using external service: ${EXTERNAL_UHDMOVIES_URL}`);
                    streams = await fetchFromExternalProvider(EXTERNAL_UHDMOVIES_URL, 'uhdmovies', tmdbId, tmdbTypeFromId, seasonNum, episodeNum);
                } else {
                    console.log(`[UHDMovies] Using local provider`);
                    streams = await getUHDMoviesStreams(tmdbId, tmdbTypeFromId, seasonNum, episodeNum);
                }
                
                if (streams && streams.length > 0) {
                    console.log(`[UHDMovies] Successfully fetched ${streams.length} streams.`);
                    // Save to cache
                    await saveStreamToCache('uhdmovies', tmdbTypeFromId, tmdbId, streams, 'ok', seasonNum, episodeNum);
                    return streams.map(stream => ({ ...stream, provider: 'UHDMovies' }));
                } else {
                    console.log(`[UHDMovies] No streams returned.`);
                    // Save empty result
                    await saveStreamToCache('uhdmovies', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                    return [];
                }
            } catch (err) {
                console.error(`[UHDMovies] Error fetching streams:`, err.message);
                // Save error status to cache
                await saveStreamToCache('uhdmovies', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                return [];
            }
        },

        // MoviesMod provider with cache integration
        moviesmod: async () => {
            if (!ENABLE_MOVIESMOD_PROVIDER) {
                console.log('[MoviesMod] Skipping fetch: Disabled by environment variable.');
                return [];
            }
            if (!shouldFetch('moviesmod')) {
                console.log('[MoviesMod] Skipping fetch: Not selected by user.');
                return [];
            }
            
            // Try to get cached streams first
            const cachedStreams = await getStreamFromCache('moviesmod', tmdbTypeFromId, tmdbId, seasonNum, episodeNum);
            if (cachedStreams) {
                console.log(`[MoviesMod] Using ${cachedStreams.length} streams from cache.`);
                return cachedStreams.map(stream => ({ ...stream, provider: 'MoviesMod' }));
            }
            
            // No cache or expired, fetch fresh
            try {
                console.log(`[MoviesMod] Fetching new streams...`);
                let streams;
                
                // Check if external service URL is configured
                if (EXTERNAL_MOVIESMOD_URL) {
                    console.log(`[MoviesMod] Using external service: ${EXTERNAL_MOVIESMOD_URL}`);
                    streams = await fetchFromExternalProvider(EXTERNAL_MOVIESMOD_URL, 'moviesmod', tmdbId, tmdbTypeFromId, seasonNum, episodeNum);
                } else {
                    console.log(`[MoviesMod] Using local provider`);
                    streams = await getMoviesModStreams(tmdbId, tmdbTypeFromId, seasonNum, episodeNum);
                }
                
                if (streams && streams.length > 0) {
                    console.log(`[MoviesMod] Successfully fetched ${streams.length} streams.`);
                    // Save to cache
                    await saveStreamToCache('moviesmod', tmdbTypeFromId, tmdbId, streams, 'ok', seasonNum, episodeNum);
                    return streams.map(stream => ({ ...stream, provider: 'MoviesMod' }));
                } else {
                    console.log(`[MoviesMod] No streams returned.`);
                    // Save empty result
                    await saveStreamToCache('moviesmod', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                    return [];
                }
            } catch (err) {
                console.error(`[MoviesMod] Error fetching streams:`, err.message);
                // Save error status to cache
                await saveStreamToCache('moviesmod', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                return [];
            }
        },

        // TopMovies provider with cache integration
        topmovies: async () => {
            if (!ENABLE_TOPMOVIES_PROVIDER) {
                console.log('[TopMovies] Skipping fetch: Disabled by environment variable.');
                return [];
            }
            if (!shouldFetch('topmovies')) {
                console.log('[TopMovies] Skipping fetch: Not selected by user.');
                return [];
            }
            
            // This provider only supports movies
            if (tmdbTypeFromId !== 'movie') {
                console.log('[TopMovies] Skipping fetch: Provider only supports movies.');
                return [];
            }

            // Try to get cached streams first
            const cachedStreams = await getStreamFromCache('topmovies', tmdbTypeFromId, tmdbId);
            if (cachedStreams) {
                console.log(`[TopMovies] Using ${cachedStreams.length} streams from cache.`);
                return cachedStreams.map(stream => ({ ...stream, provider: 'TopMovies' }));
            }
            
            // No cache or expired, fetch fresh
            try {
                console.log(`[TopMovies] Fetching new streams...`);
                let streams;
                
                // Check if external service URL is configured
                if (EXTERNAL_TOPMOVIES_URL) {
                    console.log(`[TopMovies] Using external service: ${EXTERNAL_TOPMOVIES_URL}`);
                    streams = await fetchFromExternalProvider(EXTERNAL_TOPMOVIES_URL, 'topmovies', tmdbId, tmdbTypeFromId);
                } else {
                    console.log(`[TopMovies] Using local provider`);
                    streams = await getTopMoviesStreams(tmdbId, tmdbTypeFromId);
                }
                
                if (streams && streams.length > 0) {
                    console.log(`[TopMovies] Successfully fetched ${streams.length} streams.`);
                    // Save to cache
                    await saveStreamToCache('topmovies', tmdbTypeFromId, tmdbId, streams, 'ok');
                    return streams.map(stream => ({ ...stream, provider: 'TopMovies' }));
                } else {
                    console.log(`[TopMovies] No streams returned.`);
                    // Save empty result
                    await saveStreamToCache('topmovies', tmdbTypeFromId, tmdbId, [], 'failed');
                    return [];
                }
            } catch (err) {
                console.error(`[TopMovies] Error fetching streams:`, err.message);
                // Save error status to cache
                await saveStreamToCache('topmovies', tmdbTypeFromId, tmdbId, [], 'failed');
                return [];
            }
        },

        // (Removed) DramaDrip provider

        // (Removed) AnimePahe provider

        // MoviesDrive provider with cache integration
        moviesdrive: async () => {
            if (!ENABLE_MOVIESDRIVE_PROVIDER) {
                console.log('[MoviesDrive] Skipping fetch: Disabled by environment variable.');
                return [];
            }
            if (!shouldFetch('moviesdrive')) {
                console.log('[MoviesDrive] Skipping fetch: Not selected by user.');
                return [];
            }
            
            // Try to get cached streams first
            const cachedStreams = await getStreamFromCache('moviesdrive', tmdbTypeFromId, tmdbId, seasonNum, episodeNum);
            if (cachedStreams) {
                console.log(`[MoviesDrive] Using ${cachedStreams.length} streams from cache.`);
                return cachedStreams.map(stream => ({ ...stream, provider: 'MoviesDrive' }));
            }
            
            // No cache or expired, fetch fresh
            try {
                console.log(`[MoviesDrive] Fetching new streams...`);
                const streams = await getMoviesDriveStreams(tmdbId, tmdbTypeFromId, seasonNum, episodeNum);
                
                if (streams && streams.length > 0) {
                    console.log(`[MoviesDrive] Successfully fetched ${streams.length} streams.`);
                    // Save to cache
                    await saveStreamToCache('moviesdrive', tmdbTypeFromId, tmdbId, streams, 'ok', seasonNum, episodeNum);
                    return streams.map(stream => ({ ...stream, provider: 'MoviesDrive' }));
                } else {
                    console.log(`[MoviesDrive] No streams returned.`);
                    // Save empty result
                    await saveStreamToCache('moviesdrive', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                    return [];
                }
            } catch (err) {
                console.error(`[MoviesDrive] Error fetching streams:`, err.message);
                // Save error status to cache
                await saveStreamToCache('moviesdrive', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                return [];
            }
        },

        // 4KHDHub provider with cache integration
        '4khdhub': async () => {
            if (!ENABLE_4KHDHUB_PROVIDER) {
                console.log('[4KHDHub] Skipping fetch: Disabled by environment variable.');
                return [];
            }
            if (!shouldFetch('4khdhub')) {
                console.log('[4KHDHub] Skipping fetch: Not selected by user.');
                return [];
            }
            
            // Try to get cached streams first
            const cachedStreams = await getStreamFromCache('4khdhub', tmdbTypeFromId, tmdbId, seasonNum, episodeNum);
            if (cachedStreams) {
                console.log(`[4KHDHub] Using ${cachedStreams.length} streams from cache.`);
                return cachedStreams.map(stream => ({ ...stream, provider: '4KHDHub' }));
            }
            
            // No cache or expired, fetch fresh
            try {
                console.log(`[4KHDHub] Fetching new streams...`);
                const streams = await get4KHDHubStreams(tmdbId, tmdbTypeFromId, seasonNum, episodeNum);
                
                if (streams && streams.length > 0) {
                    console.log(`[4KHDHub] Successfully fetched ${streams.length} streams.`);
                    // Save to cache
                    await saveStreamToCache('4khdhub', tmdbTypeFromId, tmdbId, streams, 'ok', seasonNum, episodeNum);
                    return streams.map(stream => ({ ...stream, provider: '4KHDHub' }));
                } else {
                    console.log(`[4KHDHub] No streams returned.`);
                    // Save empty result
                    await saveStreamToCache('4khdhub', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                    return [];
                }
            } catch (err) {
                console.error(`[4KHDHub] Error fetching streams:`, err.message);
                // Save error status to cache
                await saveStreamToCache('4khdhub', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                return [];
            }
        },

        // Vixsrc provider with cache integration
        vixsrc: async () => {
            if (!ENABLE_VIXSRC_PROVIDER) {
                console.log('[Vixsrc] Skipping fetch: Disabled by environment variable.');
                return [];
            }
            if (!shouldFetch('vixsrc')) {
                console.log('[Vixsrc] Skipping fetch: Not selected by user.');
                return [];
            }
            
            // Try to get cached streams first
            const cachedStreams = await getStreamFromCache('vixsrc', tmdbTypeFromId, tmdbId, seasonNum, episodeNum);
            if (cachedStreams) {
                console.log(`[Vixsrc] Using ${cachedStreams.length} streams from cache.`);
                return cachedStreams.map(stream => ({ ...stream, provider: 'Vixsrc' }));
            }
            
            // No cache or expired, fetch fresh
            try {
                console.log(`[Vixsrc] Fetching new streams...`);
                const streams = await getVixsrcStreams(tmdbId, tmdbTypeFromId, seasonNum, episodeNum);
                
                if (streams && streams.length > 0) {
                    console.log(`[Vixsrc] Successfully fetched ${streams.length} streams.`);
                    // Save to cache
                    await saveStreamToCache('vixsrc', tmdbTypeFromId, tmdbId, streams, 'ok', seasonNum, episodeNum);
                    return streams.map(stream => ({ ...stream, provider: 'Vixsrc' }));
                } else {
                    console.log(`[Vixsrc] No streams returned.`);
                    // Save empty result
                    await saveStreamToCache('vixsrc', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                    return [];
                }
            } catch (err) {
                console.error(`[Vixsrc] Error fetching streams:`, err.message);
                // Save error status to cache
                await saveStreamToCache('vixsrc', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                return [];
            }
        },

        // MovieBox provider with cache integration
        moviebox: async () => {
            if (!ENABLE_MOVIEBOX_PROVIDER) {
                console.log('[MovieBox] Skipping fetch: Disabled by environment variable.');
                return [];
            }
            if (!shouldFetch('moviebox')) {
                console.log('[MovieBox] Skipping fetch: Not selected by user.');
                return [];
            }
            
            // Try to get cached streams first
            const cachedStreams = await getStreamFromCache('moviebox', tmdbTypeFromId, tmdbId, seasonNum, episodeNum);
            if (cachedStreams) {
                console.log(`[MovieBox] Using ${cachedStreams.length} streams from cache.`);
                return cachedStreams.map(stream => ({ ...stream, provider: 'MovieBox' }));
            }
            
            // No cache or expired, fetch fresh
            try {
                console.log(`[MovieBox] Fetching new streams...`);
                const streams = await getMovieBoxStreams(tmdbId, tmdbTypeFromId, seasonNum, episodeNum);
                
                if (streams && streams.length > 0) {
                    console.log(`[MovieBox] Successfully fetched ${streams.length} streams.`);
                    // Save to cache
                    await saveStreamToCache('moviebox', tmdbTypeFromId, tmdbId, streams, 'ok', seasonNum, episodeNum);
                    return streams.map(stream => ({ ...stream, provider: 'MovieBox' }));
                } else {
                    console.log(`[MovieBox] No streams returned.`);
                    // Save empty result
                    await saveStreamToCache('moviebox', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                    return [];
                }
            } catch (err) {
                console.error(`[MovieBox] Error fetching streams:`, err.message);
                // Save error status to cache
                await saveStreamToCache('moviebox', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                return [];
            }
        }
    };

    // Execute all provider fetches in parallel
    console.log('Running parallel provider fetches with caching...');
    
    try {
        // Execute all provider functions in parallel with 10-second timeout
        const PROVIDER_TIMEOUT_MS = 45000; // 10 seconds
        const providerPromises = [
            timeProvider('ShowBox', providerFetchFunctions.showbox()),
            timeProvider('Soaper TV', providerFetchFunctions.soapertv()),
            timeProvider('VidSrc', providerFetchFunctions.vidsrc()),
            timeProvider('VidZee', providerFetchFunctions.vidzee()),
            timeProvider('MP4Hydra', providerFetchFunctions.mp4hydra()),
            timeProvider('UHDMovies', providerFetchFunctions.uhdmovies()), 
            timeProvider('MoviesMod', providerFetchFunctions.moviesmod()),
            timeProvider('TopMovies', providerFetchFunctions.topmovies()),
            timeProvider('MoviesDrive', providerFetchFunctions.moviesdrive()),
            timeProvider('4KHDHub', providerFetchFunctions['4khdhub']()),
            timeProvider('Vixsrc', providerFetchFunctions.vixsrc()),
            timeProvider('MovieBox', providerFetchFunctions.moviebox())
        ];
        
        // Implement proper timeout that returns results immediately after 10 seconds
        let providerResults;
        let timeoutOccurred = false;
        
        const timeoutPromise = new Promise((resolve) => {
            setTimeout(() => {
                timeoutOccurred = true;
                console.log(`[Timeout] 30-second timeout reached. Returning fetched links so far.`);
                resolve('timeout');
            }, PROVIDER_TIMEOUT_MS);
        });
        
        // Start all providers and race against timeout
        const settledPromise = Promise.allSettled(providerPromises);
        const raceResult = await Promise.race([settledPromise, timeoutPromise]);
        
        if (raceResult === 'timeout') {
            // Timeout occurred, collect results from completed providers only
            console.log(`[Timeout] Collecting results from completed providers...`);
            
            // Give a brief moment for any providers that might be just finishing
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Get current state of all promises
            const currentResults = await Promise.allSettled(providerPromises.map(p => 
                Promise.race([p, Promise.resolve([])])
            ));
            
            providerResults = currentResults.map((result, index) => {
                const providerNames = ['ShowBox', 'Soaper TV', 'VidSrc', 'VidZee', 'MP4Hydra', 'UHDMovies', 'MoviesMod', 'TopMovies', 'MoviesDrive', '4KHDHub', 'Vixsrc', 'MovieBox'];
                if (result.status === 'fulfilled' && Array.isArray(result.value) && result.value.length > 0) {
                    console.log(`[Timeout] Provider ${providerNames[index]} completed with ${result.value.length} streams.`);
                    return result.value;
                } else {
                    console.log(`[Timeout] Provider ${providerNames[index]} did not complete in time or returned no streams.`);
                    return []; // Return empty array for incomplete/failed providers
                }
            });
        } else {
            // All providers completed within timeout
            providerResults = raceResult.map(result => {
                if (result.status === 'fulfilled') {
                    return result.value;
                } else {
                    return [];
                }
            });
        }
        
        // Process results into streamsByProvider object
        const streamsByProvider = {
            'ShowBox': shouldFetch('showbox') ? applyAllStreamFilters(providerResults[0], 'ShowBox', minQualitiesPreferences.showbox, excludeCodecsPreferences.showbox) : [],
            'Soaper TV': ENABLE_SOAPERTV_PROVIDER && shouldFetch('soapertv') ? applyAllStreamFilters(providerResults[1], 'Soaper TV', minQualitiesPreferences.soapertv, excludeCodecsPreferences.soapertv) : [],
            'VidSrc': shouldFetch('vidsrc') ? applyAllStreamFilters(providerResults[2], 'VidSrc', minQualitiesPreferences.vidsrc, excludeCodecsPreferences.vidsrc) : [],
            'VidZee': ENABLE_VIDZEE_PROVIDER && shouldFetch('vidzee') ? applyAllStreamFilters(providerResults[3], 'VidZee', minQualitiesPreferences.vidzee, excludeCodecsPreferences.vidzee) : [],
            'MP4Hydra': ENABLE_MP4HYDRA_PROVIDER && shouldFetch('mp4hydra') ? applyAllStreamFilters(providerResults[4], 'MP4Hydra', minQualitiesPreferences.mp4hydra, excludeCodecsPreferences.mp4hydra) : [],
            'UHDMovies': ENABLE_UHDMOVIES_PROVIDER && shouldFetch('uhdmovies') ? applyAllStreamFilters(providerResults[5], 'UHDMovies', minQualitiesPreferences.uhdmovies, excludeCodecsPreferences.uhdmovies) : [],
            'MoviesMod': ENABLE_MOVIESMOD_PROVIDER && shouldFetch('moviesmod') ? applyAllStreamFilters(providerResults[6], 'MoviesMod', minQualitiesPreferences.moviesmod, excludeCodecsPreferences.moviesmod) : [],
            'TopMovies': ENABLE_TOPMOVIES_PROVIDER && shouldFetch('topmovies') ? applyAllStreamFilters(providerResults[7], 'TopMovies', minQualitiesPreferences.topmovies, excludeCodecsPreferences.topmovies) : [], 
            'MoviesDrive': ENABLE_MOVIESDRIVE_PROVIDER && shouldFetch('moviesdrive') ? applyAllStreamFilters(providerResults[8], 'MoviesDrive', minQualitiesPreferences.moviesdrive, excludeCodecsPreferences.moviesdrive) : [],
            '4KHDHub': ENABLE_4KHDHUB_PROVIDER && shouldFetch('4khdhub') ? applyAllStreamFilters(providerResults[9], '4KHDHub', minQualitiesPreferences['4khdhub'], excludeCodecsPreferences['4khdhub']) : [],
            'Vixsrc': ENABLE_VIXSRC_PROVIDER && shouldFetch('vixsrc') ? applyAllStreamFilters(providerResults[10], 'Vixsrc', minQualitiesPreferences.vixsrc, excludeCodecsPreferences.vixsrc) : [],
            'MovieBox': ENABLE_MOVIEBOX_PROVIDER && shouldFetch('moviebox') ? applyAllStreamFilters(providerResults[11], 'MovieBox', minQualitiesPreferences.moviebox, excludeCodecsPreferences.moviebox) : []
        };

        // Sort streams for each provider by quality, then size
        console.log('Sorting streams for each provider by quality, then size...');
        for (const provider in streamsByProvider) {
            streamsByProvider[provider].sort((a, b) => {
                const qualityA = parseQuality(a.quality);
                const qualityB = parseQuality(b.quality);
                if (qualityB !== qualityA) {
                    return qualityB - qualityA; // Higher quality first
                }
                const sizeA = parseSize(a.size);
                const sizeB = parseSize(b.size);
                return sizeB - sizeA; // Larger file first if same quality
            });
        }

        // Combine streams in the preferred provider order
        combinedRawStreams = [];
		const providerOrder = ['ShowBox', 'MovieBox', 'UHDMovies', '4KHDHub', 'MoviesMod', 'TopMovies', 'MoviesDrive', 'Soaper TV', 'VidZee', 'MP4Hydra', 'VidSrc', 'Vixsrc'];
        providerOrder.forEach(providerKey => {
            if (streamsByProvider[providerKey] && streamsByProvider[providerKey].length > 0) {
                combinedRawStreams.push(...streamsByProvider[providerKey]);
            }
        });
        
        console.log(`Total raw streams after provider-ordered fetch: ${combinedRawStreams.length}`);

    } catch (error) {
        console.error('Error during provider fetching:', error);
        // Continue with any streams we were able to fetch
    }
    
    if (combinedRawStreams.length === 0) {
        console.log(`  No streams found from any provider for TMDB ${tmdbTypeFromId}/${tmdbId}`);
        return { streams: [] };
    }
    
    console.log(`Total streams after provider-level sorting: ${combinedRawStreams.length}`);

    // Format and send the response
    const stremioStreamObjects = combinedRawStreams.map((stream) => {
        // --- Special handling for MoviesMod which has pre-formatted titles ---
        if (stream.provider === 'MoviesMod') {
            return {
                name: stream.name,    // Use the simple name from provider
                title: stream.title,  // Use the detailed title from provider
                url: stream.url,
                type: 'url',
                availability: 2,
                behaviorHints: {
                    notWebReady: true
                }
            };
        }

        // --- NEW: Special handling for TopMovies to use its pre-formatted titles ---
        if (stream.provider === 'TopMovies') {
            return {
                name: stream.name,    // Use the name from the provider, e.g., "TopMovies - 1080p"
                title: stream.title,  // Use the title from the provider, e.g., "Filename.mkv\nSize"
                url: stream.url,
                type: 'url',
                availability: 2,
                behaviorHints: {
                    notWebReady: true
                }
            };
        }

        // --- NEW: Special handling for MoviesDrive to use its pre-formatted titles ---
        if (stream.provider === 'MoviesDrive') {
            return {
                name: stream.name,    // Use the name from the provider, e.g., "MoviesDrive (Pixeldrain) - 2160p"
                title: stream.title,  // Use the title from the provider, e.g., "Title\nSize\nFilename"
                url: stream.url,
                type: 'url',
                availability: 2,
                behaviorHints: {
                    notWebReady: true
                }
            };
        }

        const qualityLabel = stream.quality || 'UNK'; // UNK for unknown
        
        let displayTitle;
        
        if (stream.provider === 'ShowBox' && stream.title) {
            displayTitle = stream.title; // Use the raw filename from ShowBox
        } else if (stream.provider === 'UHDMovies' && stream.fileName) {
            const cleanFileName = stream.fileName.replace(/\.[^/.]+$/, "").replace(/[._]/g, ' ');
            displayTitle = cleanFileName; // Use the cleaned filename as the main title
        } else if (stream.provider === 'UHDMovies' && stream.fullTitle) {
            displayTitle = stream.fullTitle;
        } else if (stream.provider === '4KHDHub' && stream.title) {
            displayTitle = stream.title; // Use the enhanced title that includes filename and size
        } else if (tmdbTypeFromId === 'tv' && seasonNum !== null && episodeNum !== null && movieOrSeriesTitle) {
            displayTitle = `${movieOrSeriesTitle} S${String(seasonNum).padStart(2, '0')}E${String(episodeNum).padStart(2, '0')}`;
        } else if (movieOrSeriesTitle) {
            if (tmdbTypeFromId === 'movie' && movieOrSeriesYear) {
                displayTitle = `${movieOrSeriesTitle} (${movieOrSeriesYear})`;
            } else {
                displayTitle = movieOrSeriesTitle;
            }
        } else {
            displayTitle = stream.title || "Unknown Title"; // Fallback to the title from the raw stream data
        }

        const flagEmoji = getFlagEmojiForUrl(stream.url);

        let providerDisplayName = stream.provider; // Default to the existing provider name
        if (stream.provider === 'ShowBox') {
            providerDisplayName = 'ShowBox';
            if (hasAnyCookies) {
                providerDisplayName += ' ⚡';
            } else {
                providerDisplayName += ' (SLOW)';
            }
        } else if (stream.provider === 'Soaper TV') {
            providerDisplayName = 'Soaper TV';
        } else if (stream.provider === 'VidZee') {
            if (stream.language) {
                providerDisplayName = `VidZee ${stream.language.toUpperCase()}`;
            }
        } else if (stream.provider === 'MP4Hydra') {
            // Extract server number from title if present
            const serverMatch = stream.title && stream.title.match(/\[MP4Hydra (#\d+)\]/);
            if (serverMatch && serverMatch[1]) {
                providerDisplayName = `MP4Hydra ${serverMatch[1]}`;
            } else {
                providerDisplayName = 'MP4Hydra';
            }
        } else if (stream.provider === 'UHDMovies') {
            providerDisplayName = 'UHDMovies';
        } else if (stream.provider === 'MoviesMod') {
            providerDisplayName = 'MoviesMod';
        } else if (stream.provider === 'TopMovies') {
            providerDisplayName = 'TopMovies';
        } else if (stream.provider === 'MoviesDrive') {
            providerDisplayName = 'MoviesDrive';
        } else if (stream.provider === '4KHDHub') {
            providerDisplayName = '4KHDHub';
        } else if (stream.provider === 'Vixsrc') {
            providerDisplayName = 'Vixsrc';
        } else if (stream.provider === 'MovieBox') {
            providerDisplayName = 'MovieBox';
        } else if (stream.provider === 'PStream') {
            providerDisplayName = '🌐 ShowBox ⚡'; // PStream streams should show as ShowBox with lightning
        }

        let nameDisplay;
        if (stream.provider === 'MP4Hydra') {
            // For MP4Hydra, we want to show the server number prominently
            const qualityLabel = stream.quality || 'UNK';
            nameDisplay = `${providerDisplayName} - ${qualityLabel}`;
        } else if (stream.provider === 'UHDMovies') {
            // For UHDMovies, show quality prominently
            const qualityLabel = stream.quality || 'UNK';
            nameDisplay = `${providerDisplayName} - ${qualityLabel}`;
        } else if (stream.provider === 'MoviesMod') {
            // For MoviesMod, use the enhanced stream title that comes from the provider
            // which includes detailed quality, codec, size, language and method information
            nameDisplay = stream.title || `${providerDisplayName} - ${stream.quality || 'UNK'}`;
        } else if (stream.provider === 'TopMovies') {
            nameDisplay = stream.title || `${providerDisplayName} - ${stream.quality || 'UNK'}`;
        } else if (stream.provider === 'MoviesDrive') {
            // For MoviesDrive, use the enhanced stream title that comes from the provider
            // which includes detailed quality, source, and size information
            nameDisplay = stream.name || `${providerDisplayName} - ${stream.quality || 'UNK'}`;
        } else if (stream.provider === '4KHDHub') {
            // For 4KHDHub, extract metadata from stream title and enhance the name
            const extractMetadata = (title) => {
                if (!title) return { nameMetadata: [], audioMetadata: [] };
                const nameMetadata = [];
                const audioMetadata = [];
                
                // Check for HDR formats
                if (/HDR10/i.test(title)) nameMetadata.push('HDR10');
                if (/\bDV\b|Dolby.?Vision/i.test(title)) nameMetadata.push('DV');
                if (/HDR/i.test(title) && !nameMetadata.includes('HDR10')) nameMetadata.push('HDR');
                
                // Check for source formats
                if (/BluRay|Blu-ray|BDRip|BRRip/i.test(title)) nameMetadata.push('BluRay');
                if (/WEB-?DL|WEBRip/i.test(title)) nameMetadata.push('WEB');
                if (/REMUX/i.test(title)) nameMetadata.push('REMUX');
                if (/DVD/i.test(title)) nameMetadata.push('DVD');
                
                // Check for special formats
                if (/IMAX/i.test(title)) nameMetadata.push('IMAX');
                
                // Check for audio formats (for title field)
                if (/ATMOS/i.test(title)) audioMetadata.push('ATMOS');
                if (/DTS/i.test(title)) audioMetadata.push('DTS');
                
                return { nameMetadata, audioMetadata };
            };
            
            // Create abbreviated server name mapping for 4KHDHub
            const getAbbreviatedServerName = (streamName) => {
                if (!streamName) return `${providerDisplayName} - ${stream.quality || 'UNK'}`;
                
                const serverMappings = {
                    'HubCloud': '[HC]',
                    'Pixeldrain': '[PD]',
                    'FSL Server': '[FSL]',
                    'BuzzServer': '[BS]',
                    'S3 Server': '[S3]',
                    '10Gbps Server': '[10G]',
                    'HubDrive': '[HD]',
                    'Direct Link': '[DL]'
                };
                
                // Extract server name from stream.name (format: "4KHDHub - ServerName - Quality")
                 const match = streamName.match(/4KHDHub - ([^-]+)/);
                 if (match) {
                     const serverName = match[1].trim();
                     const abbreviation = serverMappings[serverName] || `[${serverName.substring(0, 3).toUpperCase()}]`;
                     
                     // Format quality display
                     const quality = stream.quality || 'UNK';
                     let qualityDisplay;
                     if (quality === '2160' || quality === 2160 || quality === '2160p') {
                         qualityDisplay = '4K';
                     } else if (typeof quality === 'string' && quality.endsWith('p')) {
                         qualityDisplay = quality; // Already has 'p' suffix
                     } else {
                         qualityDisplay = `${quality}p`;
                     }
                     
                     return `4KHDHub ${abbreviation} - ${qualityDisplay}`;
                 }
                
                return streamName;
            };
            
            const baseName = getAbbreviatedServerName(stream.name);
            const { nameMetadata, audioMetadata } = extractMetadata(stream.title);
            
            // Store audio metadata for later use in title field
            stream.audioMetadata = audioMetadata;
            
            if (nameMetadata.length > 0) {
                nameDisplay = `${baseName} | ${nameMetadata.join(' | ')}`;
            } else {
                nameDisplay = baseName;
            }
        } else if (stream.provider === 'Vixsrc') {
            // For Vixsrc, show quality prominently
            const qualityLabel = stream.quality || 'UNK';
            nameDisplay = `${providerDisplayName} - ${qualityLabel}`;
        } else if (stream.provider === 'MovieBox') {
            // For MovieBox, use the name field from the provider (includes language if detected)
            nameDisplay = stream.name || `${providerDisplayName} - ${stream.quality || 'UNK'}`;
        } else { // For other providers
            const qualityLabel = stream.quality || 'UNK';
            // Skip flag emoji for PStream streams
            if (stream.provider === 'PStream') {
                nameDisplay = `${providerDisplayName} - ${qualityLabel}`;
            } else if (flagEmoji) {
                nameDisplay = `${flagEmoji} ${providerDisplayName} - ${qualityLabel}`;
            } else {
                nameDisplay = `${providerDisplayName} - ${qualityLabel}`;
            }
        }
        
        const nameVideoTechTags = [];
        if (stream.codecs && Array.isArray(stream.codecs)) {
            // For ShowBox, include all HDR-related codecs
            if (stream.provider === 'ShowBox') {
                if (stream.codecs.includes('DV')) {
                    nameVideoTechTags.push('DV');
                }
                if (stream.codecs.includes('HDR10+')) {
                    nameVideoTechTags.push('HDR10+');
                }
                if (stream.codecs.includes('HDR')) {
                    nameVideoTechTags.push('HDR');
                }
            }
            // For any other provider (that isn't UHDMovies), use the original behavior
            else if (stream.provider !== 'UHDMovies') {
                if (stream.codecs.includes('DV')) {
                    nameVideoTechTags.push('DV');
                } else if (stream.codecs.includes('HDR10+')) {
                    nameVideoTechTags.push('HDR10+');
                } else if (stream.codecs.includes('HDR')) {
                    nameVideoTechTags.push('HDR');
                }
            }
        }
        if (nameVideoTechTags.length > 0) {
            nameDisplay += ` | ${nameVideoTechTags.join(' | ')}`;
        }

        let titleParts = [];

        if (stream.codecs && Array.isArray(stream.codecs) && stream.codecs.length > 0) {
            // A more specific order for codecs
            const codecOrder = ['DV', 'HDR', 'Atmos', 'DTS-HD', 'DTS', 'EAC3', 'AC3', 'H.265', 'H.264', '10-bit'];
            const sortedCodecs = stream.codecs.slice().sort((a, b) => {
                const indexA = codecOrder.indexOf(a);
                const indexB = codecOrder.indexOf(b);
                if (indexA === -1 && indexB === -1) return 0;
                if (indexA === -1) return 1;
                if (indexB === -1) return -1;
                return indexA - indexB;
            });
            titleParts.push(...sortedCodecs);
        }

        // Prepare optional quota line for ShowBox personal cookie usage
        let quotaLine = '';

        if (stream.size && stream.size !== 'Unknown size' && !stream.size.toLowerCase().includes('n/a')) {
            let sizeWithAudio = stream.size;
            
            // Add audio metadata for 4KHDHub after size with dot separation
            if (stream.provider === '4KHDHub' && stream.audioMetadata && stream.audioMetadata.length > 0) {
                sizeWithAudio += ' • ' + stream.audioMetadata.join(' • ');
            }
            
            // Build quota remaining info for ShowBox/PStream when a personal cookie was selected (on next line)
            if ((stream.provider === 'ShowBox' || stream.provider === 'PStream') && hasAnyCookies) {
                const remainingMb = global.currentRequestUserCookieRemainingMB;
                if (typeof remainingMb === 'number' && remainingMb >= 0) {
                    const remainingGb = remainingMb >= 1024 ? `${(remainingMb / 1024).toFixed(2)} GB` : `${Math.round(remainingMb)} MB`;
                    quotaLine = `\nQuota left: ${remainingGb}`;
                }
            }

            titleParts.push(sizeWithAudio);
        }
            
        const titleSecondLine = titleParts.join(" • ");
        let finalTitle = titleSecondLine ? `${displayTitle}
${titleSecondLine}` : displayTitle;

        // Append quota line (if any) right after size/codec line
        if (quotaLine) {
            finalTitle += `${quotaLine}`;
        }

        // Add warning for ShowBox if no personal cookie is present
        if (stream.provider === 'ShowBox' && !hasAnyCookies) {
            const warningMessage = "⚠️ Slow? Add personal FebBox cookie in addon config for faster streaming.";
            finalTitle += `
${warningMessage}`;
        }

        return {
            name: nameDisplay, 
            title: finalTitle, 
            url: stream.url,
            type: 'url', // CRITICAL: This is the type of the stream itself, not the content
            availability: 2, 
            behaviorHints: {
                notWebReady: true // As per the working example, indicates Stremio might need to handle it carefully or use external player
            }
        };
    });

    console.log("--- BEGIN Stremio Stream Objects to be sent ---");
    // Log first 3 streams to keep logs shorter
    const streamSample = stremioStreamObjects.slice(0, 3);
    console.log(JSON.stringify(streamSample, null, 2));
    if (stremioStreamObjects.length > 3) {
        console.log(`... and ${stremioStreamObjects.length - 3} more streams`);
    }
    console.log("--- END Stremio Stream Objects to be sent ---");

    // No need to clean up global variables since we're not using them anymore
    const requestEndTime = Date.now();
    const totalRequestTime = requestEndTime - requestStartTime;
    console.log(`Request for ${id} completed successfully`);

    // --- Timings Summary ---
    console.log("--- Request Timings Summary ---");
    console.log(JSON.stringify(providerTimings, null, 2));
    console.log(`Total Request Time: ${formatDuration(totalRequestTime)}`);
    console.log("-------------------------------");

    // Check if 4KHDHub is not selected and add informational stream
    const is4KHDHubSelected = !selectedProvidersArray || selectedProvidersArray.includes('4khdhub');
    if (!is4KHDHubSelected && ENABLE_4KHDHUB_PROVIDER) {
        console.log("[4KHDHub] Not selected by user - adding informational stream");

        // Create informational stream about 4KHDHub
        const infoStream = {
            name: "🎯 4KHDHub - Wide Content Available",
            title: `Enable 4KHDHub Provider

• Multiple servers (HubCloud, Pixeldrain, BuzzServer)
• Extensive movie & TV collection
• Fast streaming with quality options

Add "4khdhub" to your provider configuration`,
            url: "https://github.com/tapframe/NuvioStreamsAddon#4khdhub-provider",
            type: 'url',
            availability: 1,
            behaviorHints: {
                notWebReady: false // This is informational, so web-ready
            }
        };

        stremioStreamObjects.push(infoStream);
    }

    return {
        streams: stremioStreamObjects
    };
});

// Build and export the addon
module.exports = builder.getInterface();