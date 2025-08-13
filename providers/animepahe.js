// animepahe.js - Provider for AnimePahe anime streams
const axios = require('axios');
const cheerio = require('cheerio');
const FormData = require('form-data');
const { promisify } = require('util');
const sleep = promisify(setTimeout);
const stringSimilarity = require('string-similarity');
const fs = require('fs').promises;
const path = require('path');
const RedisCache = require('../utils/redisCache');

// --- Configuration & Constants ---
const MAIN_URL = 'https://animepahe.ru';
const PROXY_URL = process.env.ANIMEPAHE_PROXY_URL || 'https://animepaheproxy.phisheranimepahe.workers.dev/?url=';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const HEADERS = {
    'Cookie': process.env.ANIMEPAHE_COOKIE || '__ddg2_=1234567890',
    'User-Agent': USER_AGENT,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache'
};
// Global forward-proxy for all outbound requests made by this provider (acts like a VPN, does not rewrite URLs)
const GLOBAL_PROXY_URL = process.env.ANIMEPAHE_PROXY_GLOBAL || process.env.animepahe_proxy_global || null;
function buildAxiosProxyConfig(proxyUrl) {
    try {
        const parsed = new URL(proxyUrl);
        const proxyConfig = {
            host: parsed.hostname,
            port: parseInt(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'))
        };
        if (parsed.username || parsed.password) {
            proxyConfig.auth = {
                username: decodeURIComponent(parsed.username),
                password: decodeURIComponent(parsed.password || '')
            };
        }
        return proxyConfig;
    } catch (err) {
        console.warn(`[AnimePahe] Invalid ANIMEPAHE_PROXY_GLOBAL value "${proxyUrl}": ${err.message}`);
        return null;
    }
}
const AXIOS_BASE_CONFIG = {
    headers: HEADERS
};
if (GLOBAL_PROXY_URL) {
    const proxyCfg = buildAxiosProxyConfig(GLOBAL_PROXY_URL);
    if (proxyCfg) {
        AXIOS_BASE_CONFIG.proxy = proxyCfg;
        console.log(`[AnimePahe] Global proxy enabled for all requests via ${proxyCfg.host}:${proxyCfg.port}`);
    } else {
        console.warn('[AnimePahe] Global proxy is set but invalid; continuing without proxy.');
    }
}
const axiosClient = axios.create(AXIOS_BASE_CONFIG);
const TMDB_API_KEY = process.env.TMDB_API_KEY || '5b9790d9305dca8713b9a0afad42ea8d';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// --- Caching Configuration ---
const CACHE_ENABLED = process.env.DISABLE_CACHE !== 'true';
console.log(`[AnimePahe] Internal cache is ${CACHE_ENABLED ? 'enabled' : 'disabled'}.`);
const CACHE_DIR = process.env.VERCEL ? path.join('/tmp', '.animepahe_cache') : path.join(__dirname, '.cache', 'animepahe');

// Initialize Redis cache
const redisCache = new RedisCache('AnimePahe');

// --- Caching Helper Functions ---
const ensureCacheDir = async () => {
    if (!CACHE_ENABLED) return;
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') {
            console.error(`[AnimePahe Cache] Error creating cache directory: ${error.message}`);
        }
    }
};

const getFromCache = async (key) => {
    if (!CACHE_ENABLED) return null;
    
    // Try Redis cache first, then fallback to file system
    const cachedData = await redisCache.getFromCache(key, '', CACHE_DIR);
    if (cachedData) {
        return cachedData.data || cachedData; // Support both new format (data field) and legacy format
    }
    
    return null;
};

const saveToCache = async (key, data) => {
    if (!CACHE_ENABLED) return;
    
    const cacheData = {
        data: data
    };
    
    // Save to both Redis and file system
    await redisCache.saveToCache(key, cacheData, '', CACHE_DIR);
};

// Initialize cache directory on startup
ensureCacheDir();

// --- Helper Functions ---
async function fetchWithRetry(url, options = {}, maxRetries = MAX_RETRIES) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await axiosClient({
                url,
                ...options,
                headers: {
                    ...HEADERS,
                    ...(options.headers || {})
                }
            });
            return response.data;
        } catch (error) {
            lastError = error;
            console.warn(`[AnimePahe] Fetch attempt ${attempt}/${maxRetries} failed for ${url}: ${error.message}`);
            
            if (attempt < maxRetries) {
                await sleep(RETRY_DELAY_MS * Math.pow(2, attempt - 1));
            }
        }
    }
    console.error(`[AnimePahe] All fetch attempts failed for ${url}. Last error:`, lastError && lastError.message);
    throw lastError || new Error(`[AnimePahe] All fetch attempts failed for ${url}`);
}

// --- TMDB Helper Functions ---
async function getTmdbAnimeDetails(tmdbId, mediaType) {
    const url = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${TMDB_API_KEY}`;
    console.log(`[AnimePahe] Fetching TMDB details for ${mediaType} ID: ${tmdbId}`);
    
    try {
        const response = await axiosClient.get(url);
        const data = response.data;
        return {
            title: data.title || data.name,
            year: new Date(data.release_date || data.first_air_date).getFullYear(),
            type: mediaType === 'movie' ? 'movie' : 'tv'
        };
    } catch (error) {
        console.error(`[AnimePahe] Error fetching TMDB details: ${error.message}`);
        return null;
    }
}

// --- AnimePahe API Functions ---
async function searchAnime(title) {
    try {
        const url = `${PROXY_URL}${MAIN_URL}/api?m=search&l=8&q=${encodeURIComponent(title)}`;
        console.log(`[AnimePahe] Searching for anime: "${title}"`);
        
        const data = await fetchWithRetry(url);
        
        if (!data || !data.data || data.data.length === 0) {
            console.log(`[AnimePahe] No results found for "${title}"`);
            return [];
        }
        
        return data.data.map(item => ({
            id: item.id,
            title: item.title,
            type: item.type,
            episodes: item.episodes,
            status: item.status,
            season: item.season,
            year: item.year,
            score: item.score,
            poster: item.poster,
            session: item.session
        }));
    } catch (error) {
        console.error(`[AnimePahe] Search error: ${error.message}`);
        return [];
    }
}

async function getEpisodesList(session) {
    try {
        const episodes = [];
        
        // First, get the first page to determine total pages
        const firstPageUrl = `${PROXY_URL}${MAIN_URL}/api?m=release&id=${session}&sort=episode_asc&page=1`;
        const firstPageData = await fetchWithRetry(firstPageUrl);
        
        if (!firstPageData || !firstPageData.data) {
            console.error('[AnimePahe] No episodes found');
            return [];
        }
        
        const { last_page: lastPage } = firstPageData;
        
        // Process first page episodes
        firstPageData.data.forEach(episodeData => {
            episodes.push({
                episode: episodeData.episode,
                title: episodeData.title || `Episode ${episodeData.episode}`,
                session: episodeData.session
            });
        });
        
        // Fetch remaining pages if needed
        if (lastPage > 1) {
            for (let page = 2; page <= lastPage; page++) {
                const pageUrl = `${PROXY_URL}${MAIN_URL}/api?m=release&id=${session}&sort=episode_asc&page=${page}`;
                const pageData = await fetchWithRetry(pageUrl);
                
                if (pageData && pageData.data) {
                    pageData.data.forEach(episodeData => {
                        episodes.push({
                            episode: episodeData.episode,
                            title: episodeData.title || `Episode ${episodeData.episode}`,
                            session: episodeData.session
                        });
                    });
                }
            }
        }
        
        // Sort episodes by episode number
        episodes.sort((a, b) => a.episode - b.episode);
        return episodes;
    } catch (error) {
        console.error(`[AnimePahe] Error generating episodes list: ${error.message}`);
        return [];
    }
}

async function getVideoLinks(animeSession, episodeSession) {
    console.log(`[AnimePahe] getVideoLinks → animeSession: ${animeSession}, episodeSession: ${episodeSession}`);
    
    try {
        const episodeUrl = `${PROXY_URL}${MAIN_URL}/play/${animeSession}/${episodeSession}`;
        console.log(`[AnimePahe] Fetching episode page: ${episodeUrl}`);
        const response = await axiosClient.get(episodeUrl, { headers: HEADERS });
        console.log(`[AnimePahe] Episode page status: ${response.status}`);
        const $ = cheerio.load(response.data);
        
        const links = [];
        
        // Extract Pahe links from download section
        $('div#pickDownload > a').each((i, elem) => {
            const $elem = $(elem);
            const href = $elem.attr('href');
            const dubText = $elem.find('span').text();
            const type = dubText.includes('eng') ? 'DUB' : 'SUB';
            
            const text = $elem.text();
            const qualityMatch = text.match(/(.+?)\s+·\s+(\d{3,4}p)/);
            const source = qualityMatch?.[1] || 'Unknown';
            const quality = qualityMatch?.[2]?.replace('p', '') || 'Unknown';
            
            if (href) {
                links.push({
                    source: `AnimePahe [Pahe] ${source} [${type}]`,
                    url: href,
                    quality: quality,
                    type: type,
                    extractor: 'pahe'
                });
            }
        });
        
        console.log(`[AnimePahe] Parsed ${links.length} download link(s) from episode page`);
        return links;
    } catch (error) {
        console.error(`[AnimePahe] Error loading video links: ${error.message}`);
        return [];
    }
}

// --- Pahe extractor - complex extraction with decryption ---
async function extractPahe(url) {
    console.log(`[AnimePahe] extractPahe → Starting extraction for: ${url}`);
    try {
        // Step 1: Get redirect location from /i endpoint
        const redirectResponse = await axiosClient.get(`${url}/i`, {
            maxRedirects: 0,
            validateStatus: (status) => status >= 200 && status < 400,
            headers: HEADERS
        });
        
        const location = redirectResponse.headers.location;
        if (!location) {
            console.error('[AnimePahe] No redirect location found');
            return null;
        }
        
        const kwikUrl = 'https://' + location.split('https://').pop();
        console.log(`[AnimePahe] Kwik URL: ${kwikUrl}`);
        
        // Step 2: Get the Kwik page content
        const kwikResponse = await axiosClient.get(kwikUrl, {
            headers: {
                ...HEADERS,
                'Referer': 'https://kwik.cx/'
            }
        });
        
        const kwikContent = kwikResponse.data;
        
        // Step 3: Extract parameters for decryption
        const paramsMatch = kwikContent.match(/\("(\w+)",\d+,"(\w+)",(\d+),(\d+),\d+\)/);
        if (!paramsMatch) {
            console.error('[AnimePahe] Could not find decryption parameters');
            return null;
        }
        
        const [, fullString, key, v1, v2] = paramsMatch;
        console.log(`[AnimePahe] Decryption params extracted (v1=${v1}, v2=${v2}).`);
        
        // Step 4: Decrypt using the custom algorithm
        const decrypted = decryptPahe(fullString, key, parseInt(v1), parseInt(v2));
        
        // Step 5: Extract URL and token from decrypted content
        const urlMatch = decrypted.match(/action="([^"]+)"/);
        const tokenMatch = decrypted.match(/value="([^"]+)"/);
        
        if (!urlMatch || !tokenMatch) {
            console.error('[AnimePahe] Could not extract URL or token from decrypted content');
            return null;
        }
        
        const postUrl = urlMatch[1];
        const token = tokenMatch[1];
        
        // Step 6: Make POST request with form data to get final URL
        const formData = new FormData();
        formData.append('_token', token);
        
        const finalResponse = await axiosClient.post(postUrl, formData, {
            headers: {
                ...HEADERS,
                'Referer': kwikResponse.request.res.responseUrl,
                'Cookie': kwikResponse.headers['set-cookie']?.[0] || ''
            },
            maxRedirects: 0,
            validateStatus: (status) => status >= 200 && status < 400
        });
        
        if (finalResponse.status !== 302) {
            console.error('[AnimePahe] Failed to get redirect');
            return null;
        }
        
        const finalUrl = finalResponse.headers.location;
        console.log(`[AnimePahe] Final video URL extracted successfully`);
        
        return {
            url: finalUrl,
            headers: {
                'Referer': ''
            },
            type: 'direct'
        };
        
    } catch (error) {
        console.error(`[AnimePahe] Error extracting from Pahe: ${error.message}`);
        return null;
    }
}

// Pahe decryption algorithm
function decryptPahe(fullString, key, v1, v2) {
    const keyIndexMap = {};
    for (let i = 0; i < key.length; i++) {
        keyIndexMap[key[i]] = i;
    }
    
    let result = '';
    let i = 0;
    const toFind = key[v2];
    
    while (i < fullString.length) {
        const nextIndex = fullString.indexOf(toFind, i);
        if (nextIndex === -1) break;
        
        let decodedCharStr = '';
        for (let j = i; j < nextIndex; j++) {
            const index = keyIndexMap[fullString[j]];
            if (index !== undefined) {
                decodedCharStr += index;
            } else {
                decodedCharStr += '-1';
            }
        }
        
        i = nextIndex + 1;
        
        const decodedValue = parseInt(decodedCharStr, v2) - v1;
        const decodedChar = String.fromCharCode(decodedValue);
        result += decodedChar;
    }
    
    return result;
}

// --- Main function to get streams ---
async function getAnimePaheStreams(tmdbId, title, mediaType, seasonNum = null, episodeNum = null, seasonTitle = null) {
    console.log(`[AnimePahe] Attempting to fetch streams for TMDB ID: ${tmdbId}, Type: ${mediaType}${mediaType === 'tv' ? `, S:${seasonNum}E:${episodeNum}` : ''}`);
    
    const cacheKey = `animepahe_final_v1_${tmdbId}_${mediaType}${seasonNum ? `_s${seasonNum}e${episodeNum}` : ''}`;

    try {
        // 1. Check cache first
        let cachedStreams = await getFromCache(cacheKey);
        if (cachedStreams && cachedStreams.length > 0) {
            console.log(`[AnimePahe] Cache HIT for ${cacheKey}. Using ${cachedStreams.length} cached streams.`);
            return cachedStreams;
        } else {
            if (cachedStreams && cachedStreams.length === 0) {
                console.log(`[AnimePahe] Cache contains empty data for ${cacheKey}. Refetching from source.`);
            } else {
                console.log(`[AnimePahe] Cache MISS for ${cacheKey}. Fetching from source.`);
            }
        }

        // For movies, we don't need season/episode numbers
        if (mediaType === 'movie' && (seasonNum !== null || episodeNum !== null)) {
            console.log('[AnimePahe] Ignoring season/episode numbers for movie');
            seasonNum = null;
            episodeNum = null;
        }
        
        // For TV shows, we need both season and episode numbers
        if (mediaType === 'tv' && (seasonNum === null || episodeNum === null)) {
            console.error('[AnimePahe] Missing season or episode number for TV show');
            await saveToCache(cacheKey, []); // Cache empty result
            return [];
        }
        
        // Step 1: Get anime details from TMDB
        const tmdbDetails = await getTmdbAnimeDetails(tmdbId, mediaType);
        if (!tmdbDetails) {
            console.error('[AnimePahe] Failed to get TMDB details');
            return [];
        }
        
        // Prioritize title passed from addon.js, fallback to fetched title.
        const animeTitle = title || tmdbDetails.title;
        const { year } = tmdbDetails;
        console.log(`[AnimePahe] Using details: Title="${animeTitle}", Year=${year}, SeasonTitle="${seasonTitle}"`);
        
        // Step 2: Search for the anime on AnimePahe
        const searchResults = await searchAnime(animeTitle);
        if (searchResults.length === 0) {
            console.log(`[AnimePahe] No search results found for "${animeTitle}"`);
            return [];
        }
        
        // Find the best match
        let bestMatch = null;

        // If it's a series with a specific, non-generic season title, use similarity matching
        if (mediaType === 'tv' && seasonNum && seasonTitle && seasonTitle.toLowerCase() !== `season ${seasonNum}`) {
            console.log(`[AnimePahe] Using season title "${seasonTitle}" for advanced matching.`);
            
            // Filter results to only include those that contain the main anime title to avoid matching unrelated animes
            const relevantResults = searchResults.filter(r => r.title.toLowerCase().includes(animeTitle.toLowerCase()));
            const resultsToSearch = relevantResults.length > 0 ? relevantResults : searchResults;

            const titles = resultsToSearch.map(r => r.title);
            const { bestMatch: similarityMatch } = stringSimilarity.findBestMatch(seasonTitle, titles);

            if (similarityMatch && similarityMatch.rating > 0.2) {
                bestMatch = resultsToSearch.find(r => r.title === similarityMatch.target);
                console.log(`[AnimePahe] Found best match with season title: "${bestMatch.title}" (Rating: ${similarityMatch.rating.toFixed(2)})`);
            } else {
                 console.log(`[AnimePahe] No good match found with season title (Best Rating: ${similarityMatch ? similarityMatch.rating.toFixed(2) : 'N/A'}).`);
            }
        }
        
        // Fallback for movies, or if advanced matching failed
        if (!bestMatch) {
            console.log('[AnimePahe] Using basic title/year matching as fallback.');
            
            // Prioritize exact title and year match from the main show. This is good for Season 1.
            bestMatch = searchResults.find(r => r.title.toLowerCase() === animeTitle.toLowerCase() && r.year === year);
            
            if (!bestMatch) {
                // If we have a specific season but matching failed, we can't just take the first result.
                if (seasonTitle && seasonTitle.toLowerCase() !== `season ${seasonNum}`) {
                    console.error(`[AnimePahe] Could not find a specific match for season "${seasonTitle}". Aborting.`);
                    return [];
                }
                
                // For movies or S1, taking first result is a reasonable fallback.
                if(searchResults.length > 0) {
                    bestMatch = searchResults[0];
                    console.log(`[AnimePahe] Fallback: using first result: "${bestMatch.title}"`);
                }
            }
        }
        
        if (!bestMatch) {
            console.log(`[AnimePahe] No search results match for "${animeTitle}"`);
            return [];
        }
        
        // Step 3: For TV shows, get episodes list and find the right episode
        let episodeSession = null;
        if (mediaType === 'tv') {
            const episodesList = await getEpisodesList(bestMatch.session);
            if (episodesList.length === 0) {
                console.error('[AnimePahe] No episodes found for the matched series.');
                return [];
            }
            
            // Since we've matched the specific season, we can use the episode number directly.
            const targetEpisode = episodesList.find(ep => ep.episode === episodeNum);
            
            if (!targetEpisode) {
                console.error(`[AnimePahe] Episode ${episodeNum} not found in matched series "${bestMatch.title}".`);
                
                // Try to find the closest episode as a fallback
                if (episodesList.length > 0) {
                    const closest = episodesList.reduce((prev, curr) => 
                        Math.abs(curr.episode - episodeNum) < Math.abs(prev.episode - episodeNum) ? curr : prev
                    );
                    
                    console.log(`[AnimePahe] Using closest episode: ${closest.episode} (${closest.title})`);
                    episodeSession = closest.session;
                }
            } else {
                console.log(`[AnimePahe] Found episode: ${targetEpisode.episode} (${targetEpisode.title})`);
                episodeSession = targetEpisode.session;
            }
        } else {
            // For movies, we use the first episode
            const episodesList = await getEpisodesList(bestMatch.session);
            if (episodesList.length === 0) {
                console.error('[AnimePahe] No episodes found for movie');
                return [];
            }
            
            episodeSession = episodesList[0].session;
            console.log(`[AnimePahe] Using first episode for movie: ${episodesList[0].episode} (${episodesList[0].title})`);
        }
        
        if (!episodeSession) {
            console.error('[AnimePahe] Failed to get episode session');
            return [];
        }
        
        // Step 4: Get video links
        const videoLinks = await getVideoLinks(bestMatch.session, episodeSession);
        if (videoLinks.length === 0) {
            console.error('[AnimePahe] No video links found');
            return [];
        }
        
        // Step 5: Extract streams from video links
        const streams = [];
        for (const link of videoLinks) {
            try {
                console.log(`[AnimePahe] Extracting stream for ${link.source} (${link.quality}p)`);
                const extractedStream = await extractPahe(link.url);
                
                if (extractedStream) {
                    streams.push({
                        name: `AnimePahe ${link.type} ${link.quality}p`,
                        title: `AnimePahe ${link.type} ${link.quality}p`,
                        url: extractedStream.url,
                        behaviorHints: {
                            notWebReady: false,
                            proxyHeaders: extractedStream.headers || {}
                        },
                        quality: link.quality,
                        type: 'direct',
                        provider: 'AnimePahe'
                    });
                }
            } catch (error) {
                console.error(`[AnimePahe] Error extracting stream: ${error.message}`);
            }
        }
        
        console.log(`[AnimePahe] Found ${streams.length} streams`);
        
        // Save to cache
        await saveToCache(cacheKey, streams);
        
        return streams;
    } catch (error) {
        console.error(`[AnimePahe] Error getting streams: ${error.message}`);
        // Cache empty result to prevent re-scraping
        await saveToCache(cacheKey, []);
        return [];
    }
}

module.exports = { getAnimePaheStreams };