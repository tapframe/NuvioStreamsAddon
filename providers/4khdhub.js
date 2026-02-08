const cheerio = require('cheerio');
const bytes = require('bytes');
const levenshtein = require('fast-levenshtein');
const rot13Cipher = require('rot13-cipher');
const { URL } = require('url');
const path = require('path');
const fs = require('fs').promises;
const RedisCache = require('../utils/redisCache');
const { findCountryCodes, getFlags } = require('../utils/language');
const fetcher = require('../utils/Fetcher');
const TMDBFetcher = require('../utils/TMDBFetcher');
const { extractResolution } = require('../utils/resolution');

// Debug logging - always enabled for now to track issues
const log = console.log;
const logWarn = console.warn;

// Cache configuration
const CACHE_ENABLED = process.env.DISABLE_CACHE !== 'true';
const CACHE_DIR = process.env.VERCEL ? path.join('/tmp', '.4khdhub_cache') : path.join(__dirname, '.cache', '4khdhub');
const redisCache = new RedisCache('4KHDHub');

// Helper to ensure cache directory exists
const ensureCacheDir = async () => {
    if (!CACHE_ENABLED) return;
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
    } catch (error) {
        console.error(`[4KHDHub] Error creating cache directory: ${error.message}`);
    }
};
ensureCacheDir();

const BASE_URL = 'https://4khdhub.dad';
const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';

// Initialize TMDB fetcher with mutex locking
const tmdbFetcher = new TMDBFetcher(TMDB_API_KEY);

// Polyfill for atob if not available globally
const atob = (str) => Buffer.from(str, 'base64').toString('binary');

// Helper to fetch text content
async function fetchText(url, options = {}) {
    try {
        return await fetcher.text(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                ...options.headers
            },
            timeout: 10000
        });
    } catch (error) {
        console.error(`[4KHDHub] Request failed for ${url}: ${error.message}`);
        return null;
    }
}

// Fetch TMDB Details
async function getTmdbDetails(tmdbId, type) {
    try {
        const isSeries = type === 'series' || type === 'tv';
        log(`[4KHDHub] Fetching TMDB details for ${isSeries ? 'tv' : 'movie'}/${tmdbId}`);

        const data = await tmdbFetcher.getDetails(tmdbId, isSeries ? 'tv' : 'movie');

        if (isSeries) {
            return {
                title: data.name,
                year: data.first_air_date ? parseInt(data.first_air_date.split('-')[0]) : 0
            };
        } else {
            return {
                title: data.title,
                year: data.release_date ? parseInt(data.release_date.split('-')[0]) : 0
            };
        }
    } catch (error) {
        console.error(`[4KHDHub] TMDB request failed: ${error.message}`);
        return null;
    }
}

// FourKHDHub Logic - search by name ONLY, not name+year
async function fetchPageUrl(name, year, isSeries) {
    const cacheKey = `search_v2_${name.replace(/[^a-z0-9]/gi, '_')}_${year}`;

    if (CACHE_ENABLED) {
        const cached = await redisCache.getFromCache(cacheKey, '', CACHE_DIR);
        if (cached) {
            return cached.data || cached;
        }
    }

    // CRITICAL: Search by NAME ONLY (webstrymr does this, searching with year fails)
    const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(name)}`;
    log(`[4KHDHub] Searching: ${searchUrl}`);
    const html = await fetchText(searchUrl);
    if (!html) return null;

    const $ = cheerio.load(html);
    const targetType = isSeries ? 'Series' : 'Movies';

    // Find cards that contain the correct type
    const matchingCards = $('.movie-card')
        .filter((_i, el) => {
            const hasFormat = $(el).find(`.movie-card-format:contains("${targetType}")`).length > 0;
            return hasFormat;
        })
        .filter((_i, el) => {
            const metaText = $(el).find('.movie-card-meta').text();
            const movieCardYear = parseInt(metaText);
            return !isNaN(movieCardYear) && Math.abs(movieCardYear - year) <= 1;
        })
        .filter((_i, el) => {
            const movieCardTitle = $(el).find('.movie-card-title')
                .text()
                .replace(/\[.*?]/g, '')
                .trim();

            // Use webstrymr's exact matching logic with improvements for subtitles
            const diff = levenshtein.get(movieCardTitle, name, { useCollator: true });

            // Allow exact match (diff < 5) OR partial match if title contains name
            // Increased threshold to 25 to handle subtitles like "The Hedge Knight"
            // Also allow if movieCardTitle starts with name (handles subtitles after main title)
            const startsWithName = movieCardTitle.toLowerCase().startsWith(name.toLowerCase());
            return diff < 5 || startsWithName || (movieCardTitle.includes(name) && diff < 25);
        })
        .map((_i, el) => {
            let href = $(el).attr('href');
            if (href && !href.startsWith('http')) {
                href = BASE_URL + (href.startsWith('/') ? '' : '/') + href;
            }
            return href;
        })
        .get();

    const result = matchingCards.length > 0 ? matchingCards[0] : null;
    if (result) {
        log(`[4KHDHub] Found page: ${result}`);
    } else {
        log(`[4KHDHub] No matching pages found for "${name}" (${year})`);
    }

    if (CACHE_ENABLED && result) {
        await redisCache.saveToCache(cacheKey, { data: result }, '', CACHE_DIR, 86400); // 1 day TTL
    }
    return result;
}

async function resolveRedirectUrl(redirectUrl) {
    const cacheKey = `redirect_v2_${redirectUrl.replace(/[^a-z0-9]/gi, '')}`;
    if (CACHE_ENABLED) {
        const cached = await redisCache.getFromCache(cacheKey, '', CACHE_DIR);
        if (cached) return cached.data || cached;
    }

    const redirectHtml = await fetchText(redirectUrl);
    if (!redirectHtml) return null;

    try {
        const redirectDataMatch = redirectHtml.match(/'o','(.*?)'/);
        if (!redirectDataMatch) return null;

        // Correct decode order: atob(rot13Cipher(atob(atob(data))))
        const step1 = atob(redirectDataMatch[1]);      // First base64 decode
        const step2 = atob(step1);                     // Second base64 decode
        const step3 = rot13Cipher(step2);              // ROT13 decode
        const step4 = atob(step3);                     // Third base64 decode
        const redirectData = JSON.parse(step4);

        if (redirectData && redirectData.o) {
            const resolved = atob(redirectData.o);
            if (CACHE_ENABLED) {
                await redisCache.saveToCache(cacheKey, { data: resolved }, '', CACHE_DIR, 86400 * 3); // 3 days
            }
            return resolved;
        }
    } catch (e) {
        console.error(`[4KHDHub] Error resolving redirect: ${e.message}`);
    }
    return null;
}

async function extractSourceResults($, el) {
    const localHtml = $(el).html();
    const sizeMatch = localHtml.match(/([\d.]+ ?[GM]B)/);
    let heightMatch = localHtml.match(/\d{3,}p/);

    const title = $(el).find('.file-title, .episode-file-title').text().trim();

    // If quality detection failed from HTML, try the title
    if (!heightMatch) {
        heightMatch = title.match(/(\d{3,4})p/i);
    }

    // Fallback for "4K"
    let height = heightMatch ? parseInt(heightMatch[0]) : 0;
    if (height === 0 && (title.includes('4K') || title.includes('4k') || localHtml.includes('4K') || localHtml.includes('4k'))) {
        height = 2160;
    }

    // Detect country codes from HTML content (for language flags)
    const countryCodes = ['multi', ...findCountryCodes(localHtml)];

    const meta = {
        bytes: sizeMatch ? bytes.parse(sizeMatch[1]) : 0,
        height: height,
        title: title,
        countryCodes: countryCodes
    };

    // Prefer HubCloud link (usually more reliable)
    let hubCloudLink = $(el).find('a')
        .filter((_i, a) => $(a).text().includes('HubCloud'))
        .attr('href');

    if (hubCloudLink) {
        const resolved = await resolveRedirectUrl(hubCloudLink);
        if (resolved) {
            return { url: resolved, meta, source: 'HubCloud' };
        }
    }

    // Fallback to HubDrive link
    let hubDriveLink = $(el).find('a')
        .filter((_i, a) => $(a).text().includes('HubDrive'))
        .attr('href');

    if (hubDriveLink) {
        const resolved = await resolveRedirectUrl(hubDriveLink);
        if (resolved) {
            return { url: resolved, meta, source: 'HubDrive' };
        }
    }

    return null;
}

// HubCloud Extractor - extracts FSL and PixelServer links
async function extractHubCloud(hubCloudUrl, baseMeta) {
    if (!hubCloudUrl) return [];

    try {
        // Step 1: Fetch the redirect page
        const headers = { Referer: hubCloudUrl };
        const redirectHtml = await fetchText(hubCloudUrl, { headers });
        if (!redirectHtml) return [];

        // Step 2: Extract the var url = '...' from the page
        const redirectUrlMatch = redirectHtml.match(/var url ?= ?'(.*?)'/);
        if (!redirectUrlMatch) {
            log(`[4KHDHub] No redirect URL found in HubCloud page`);
            return [];
        }

        // Step 3: Fetch the actual links page
        const finalLinksUrl = redirectUrlMatch[1];
        log(`[4KHDHub] Fetching links from: ${finalLinksUrl.substring(0, 50)}...`);
        const linksHtml = await fetchText(finalLinksUrl, { headers: { Referer: hubCloudUrl } });
        if (!linksHtml) return [];

        const $ = cheerio.load(linksHtml);
        const results = [];

        // Extract size and title from the page
        const sizeText = $('#size').text();
        const titleText = $('title').text().trim();
        const parsedSize = bytes.parse(sizeText) || baseMeta.bytes;

        // Update meta with page info
        const currentMeta = {
            ...baseMeta,
            bytes: parsedSize,
            title: titleText || baseMeta.title
        };

        // Step 4: Find FSL link
        $('a').each((_i, el) => {
            const text = $(el).text();
            const href = $(el).attr('href');
            if (!href) return;

            if (text.includes('FSL') && !text.includes('FSLv2')) {
                results.push({
                    source: 'FSL',
                    url: href,
                    meta: currentMeta
                });
                log(`[4KHDHub] Found FSL link`);
            }
        });

        // Step 5: Find PixelServer link
        $('a').each((_i, el) => {
            const text = $(el).text();
            const href = $(el).attr('href');
            if (!href) return;

            if (text.includes('PixelServer')) {
                // Convert /u/ to /api/file/ for direct download
                const pixelUrl = href.replace('/u/', '/api/file/');
                results.push({
                    source: 'PixelDrain',  // Using PixelDrain for display
                    url: pixelUrl,
                    meta: currentMeta
                });
                log(`[4KHDHub] Found PixelServer link`);
            }
        });

        log(`[4KHDHub] HubCloud extraction found ${results.length} servers`);
        return results;
    } catch (e) {
        console.error(`[4KHDHub] HubCloud extraction error: ${e.message}`);
        return [];
    }
}


async function get4KHDHubStreams(tmdbId, type, season = null, episode = null) {
    const tmdbDetails = await getTmdbDetails(tmdbId, type);
    if (!tmdbDetails) return [];

    const { title, year } = tmdbDetails;
    log(`[4KHDHub] Search: ${title} (${year})`);

    const isSeries = type === 'series' || type === 'tv';
    const pageUrl = await fetchPageUrl(title, year, isSeries);
    if (!pageUrl) {
        log(`[4KHDHub] Page not found`);
        return [];
    }
    log(`[4KHDHub] Found page: ${pageUrl}`);

    const html = await fetchText(pageUrl);
    if (!html) return [];
    const $ = cheerio.load(html);

    let itemsToProcess = [];

    if (isSeries && season && episode) {
        // Find specific season and episode
        const seasonStr = `S${String(season).padStart(2, '0')}`;
        const episodeStr = `Episode-${String(episode).padStart(2, '0')}`;

        $('.episode-item').each((_i, el) => {
            if ($('.episode-title', el).text().includes(seasonStr)) {
                const downloadItems = $('.episode-download-item', el)
                    .filter((_j, item) => $(item).text().includes(episodeStr));

                downloadItems.each((_k, item) => {
                    itemsToProcess.push(item);
                });
            }
        });
    } else {
        // Movies
        $('.download-item').each((_i, el) => {
            itemsToProcess.push(el);
        });
    }

    log(`[4KHDHub] Processing ${itemsToProcess.length} items`);

    const streams = [];

    for (const item of itemsToProcess) {
        try {
            const sourceResult = await extractSourceResults($, item);
            if (sourceResult && sourceResult.url) {
                // If it's a HubCloud link, extract multiple servers (FSL + PixelDrain)
                if (sourceResult.source === 'HubCloud') {
                    log(`[4KHDHub] Processing HubCloud link...`);
                    const hubCloudLinks = await extractHubCloud(sourceResult.url, sourceResult.meta);

                    for (const link of hubCloudLinks) {
                        const flags = getFlags(link.meta.countryCodes || sourceResult.meta.countryCodes);
                        const resolution = extractResolution(link.meta.title) || '';
                        const resolutionStr = resolution ? ` | ${resolution}` : '';

                        streams.push({
                            name: `4KHDHub | ${flags}${resolutionStr}`,
                            title: `${link.meta.title}\n📦 ${bytes.format(link.meta.bytes || 0)} 🔗 HubCloud(${link.source})`,
                            url: link.url,
                            quality: resolution || undefined,
                            behaviorHints: {
                                bingeGroup: `4khdhub-hubcloud-${link.source.toLowerCase()}`
                            }
                        });
                    }
                } else {
                    // Direct HubDrive link
                    log(`[4KHDHub] Extracted ${sourceResult.source} link: ${sourceResult.url.substring(0, 50)}...`);

                    const flags = getFlags(sourceResult.meta.countryCodes);
                    const resolution = extractResolution(sourceResult.meta.title) || '';
                    const resolutionStr = resolution ? ` | ${resolution}` : '';

                    streams.push({
                        name: `4KHDHub | ${flags}${resolutionStr}`,
                        title: `${sourceResult.meta.title}\n📦 ${bytes.format(sourceResult.meta.bytes || 0)}`,
                        url: sourceResult.url,
                        quality: resolution || undefined,
                        behaviorHints: {
                            bingeGroup: `4khdhub-${sourceResult.source.toLowerCase()}`
                        }
                    });
                }
            }
        } catch (err) {
            console.error(`[4KHDHub] Item processing error: ${err.message}`);
        }
    }

    log(`[4KHDHub] Returning ${streams.length} streams`);
    return streams;
}

module.exports = { get4KHDHubStreams };