// animepahe.js - Provider for AnimePahe anime streams
const axios = require('axios');
const cheerio = require('cheerio');
const FormData = require('form-data');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const { promisify } = require('util');
const sleep = promisify(setTimeout);
const stringSimilarity = require('string-similarity');

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
const TMDB_API_KEY = process.env.TMDB_API_KEY || '5b9790d9305dca8713b9a0afad42ea8d'; // Public API key
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// Determine cache directory based on environment
const CACHE_DIR = process.env.VERCEL ? path.join('/tmp', '.cache') : path.join(__dirname, '.cache', 'animepahe');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// --- Cache Management Functions ---
const ensureCacheDir = async () => {
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') {
            console.warn(`[AnimePahe] Warning: Could not create cache directory ${CACHE_DIR}: ${error.message}`);
        }
    }
};

const getFromCache = async (cacheKey) => {
    if (process.env.DISABLE_CACHE === 'true') {
        console.log(`[AnimePahe] CACHE DISABLED: Skipping read for ${cacheKey}`);
        return null;
    }
    const cachePath = path.join(CACHE_DIR, `${cacheKey}.json`);
    try {
        const data = await fs.readFile(cachePath, 'utf-8');
        const parsed = JSON.parse(data);
        
        // Check if cache is expired
        if (parsed.timestamp && Date.now() - parsed.timestamp < CACHE_TTL_MS) {
            console.log(`[AnimePahe] CACHE HIT for: ${cacheKey}`);
            return parsed.data;
        } else {
            console.log(`[AnimePahe] CACHE EXPIRED for: ${cacheKey}`);
            return null;
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn(`[AnimePahe] CACHE READ ERROR for ${cacheKey}: ${error.message}`);
        }
        return null;
    }
};

const saveToCache = async (cacheKey, content) => {
    if (process.env.DISABLE_CACHE === 'true') {
        console.log(`[AnimePahe] CACHE DISABLED: Skipping write for ${cacheKey}`);
        return;
    }
    await ensureCacheDir();
    const cachePath = path.join(CACHE_DIR, `${cacheKey}.json`);
    try {
        const dataToSave = {
            timestamp: Date.now(),
            data: content
        };
        await fs.writeFile(cachePath, JSON.stringify(dataToSave, null, 2), 'utf-8');
        console.log(`[AnimePahe] SAVED TO CACHE: ${cacheKey}`);
    } catch (error) {
        console.warn(`[AnimePahe] CACHE WRITE ERROR for ${cacheKey}: ${error.message}`);
    }
};

// --- Helper Functions ---
async function fetchWithRetry(url, options = {}, maxRetries = MAX_RETRIES) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios({
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
        const response = await axios.get(url);
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
    const cacheKey = `search_${title.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
    const cachedResults = await getFromCache(cacheKey);
    if (cachedResults) return cachedResults;
    
    try {
        const url = `${PROXY_URL}${MAIN_URL}/api?m=search&l=8&q=${encodeURIComponent(title)}`;
        console.log(`[AnimePahe] Searching for anime: "${title}"`);
        
        const data = await fetchWithRetry(url);
        
        if (!data || !data.data || data.data.length === 0) {
            console.log(`[AnimePahe] No results found for "${title}"`);
            return [];
        }
        
        const results = data.data.map(item => ({
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
        
        await saveToCache(cacheKey, results);
        return results;
    } catch (error) {
        console.error(`[AnimePahe] Search error: ${error.message}`);
        return [];
    }
}

async function loadAnimeDetails(session) {
    const cacheKey = `anime_${session}`;
    const cachedDetails = await getFromCache(cacheKey);
    if (cachedDetails) return cachedDetails;
    
    try {
        const url = `${PROXY_URL}${MAIN_URL}/anime/${session}`;
        console.log(`[AnimePahe] Loading anime details for session: ${session}`);
        
        const response = await axios.get(url, { headers: HEADERS });
        const $ = cheerio.load(response.data);
        
        const japTitle = $('h2.japanese').text();
        const animeTitle = $('span.sr-only.unselectable').text();
        const poster = $('.anime-poster a').attr('href');
        const tvType = $('a[href*="/anime/type/"]').text();
        
        const year = response.data.match(/<strong>Aired:<\/strong>[^,]*, (\d+)/)?.[1];
        
        let status = 'Unknown';
        if ($('a[href="/anime/airing"]').length > 0) status = 'Ongoing';
        else if ($('a[href="/anime/completed"]').length > 0) status = 'Completed';
        
        const animeDetails = {
            title: animeTitle || japTitle || '',
            engName: animeTitle,
            japName: japTitle,
            poster: poster,
            type: tvType.includes('Movie') ? 'movie' : 'tv',
            year: parseInt(year) || null,
            status: status,
            session: session
        };
        
        await saveToCache(cacheKey, animeDetails);
        return animeDetails;
    } catch (error) {
        console.error(`[AnimePahe] Error loading anime details: ${error.message}`);
        return null;
    }
}

async function getEpisodesList(session) {
    const cacheKey = `episodes_${session}`;
    const cachedEpisodes = await getFromCache(cacheKey);
    if (cachedEpisodes) return cachedEpisodes;
    
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
        
        await saveToCache(cacheKey, episodes);
        return episodes;
    } catch (error) {
        console.error(`[AnimePahe] Error generating episodes list: ${error.message}`);
        return [];
    }
}

async function getVideoLinks(animeSession, episodeSession) {
    const cacheKey = `links_${animeSession}_${episodeSession}`;
    const cachedLinks = await getFromCache(cacheKey);
    if (cachedLinks) return cachedLinks;
    
    try {
        const episodeUrl = `${PROXY_URL}${MAIN_URL}/play/${animeSession}/${episodeSession}`;
        const response = await axios.get(episodeUrl, { headers: HEADERS });
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
        
        await saveToCache(cacheKey, links);
        return links;
    } catch (error) {
        console.error(`[AnimePahe] Error loading video links: ${error.message}`);
        return [];
    }
}

// --- Pahe extractor - complex extraction with decryption ---
async function extractPahe(url) {
    try {
        // Step 1: Get redirect location from /i endpoint
        const redirectResponse = await axios.get(`${url}/i`, {
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
        
        // Step 2: Get the Kwik page content
        const kwikResponse = await axios.get(kwikUrl, {
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
        
        const finalResponse = await axios.post(postUrl, formData, {
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
    console.log(`[AnimePahe] Getting streams for TMDB ID: ${tmdbId}, Type: ${mediaType}, Season: ${seasonNum}, Episode: ${episodeNum}`);
    
    try {
        // For movies, we don't need season/episode numbers
        if (mediaType === 'movie' && (seasonNum !== null || episodeNum !== null)) {
            console.log('[AnimePahe] Ignoring season/episode numbers for movie');
            seasonNum = null;
            episodeNum = null;
        }
        
        // For TV shows, we need both season and episode numbers
        if (mediaType === 'tv' && (seasonNum === null || episodeNum === null)) {
            console.error('[AnimePahe] Missing season or episode number for TV show');
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
            if(relevantResults.length === 0) {
                console.log("[AnimePahe] No search results contain the main title, using all search results for matching.");
            }
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
        
        // Step 3: Get anime details
        const animeDetails = await loadAnimeDetails(bestMatch.session);
        if (!animeDetails) {
            console.error('[AnimePahe] Failed to load anime details');
            return [];
        }
        
        // Step 4: For TV shows, get episodes list and find the right episode
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
        
        // Step 5: Get video links
        const videoLinks = await getVideoLinks(bestMatch.session, episodeSession);
        if (videoLinks.length === 0) {
            console.error('[AnimePahe] No video links found');
            return [];
        }
        
        // Step 6: Extract streams from video links
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
        return streams;
    } catch (error) {
        console.error(`[AnimePahe] Error getting streams: ${error.message}`);
        return [];
    }
}

module.exports = { getAnimePaheStreams }; 