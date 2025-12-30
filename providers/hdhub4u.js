/**
 * HDHub4u Provider for Stremio Addon
clea * Based on the standalone scraper from scrapersdirect/hdhub4u-scraper.js
 * Supports both movies and TV series
 */

const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const { findBestMatch } = require('string-similarity');
const fs = require('fs').promises;
const path = require('path');
const RedisCache = require('../utils/redisCache');

// Create an https agent to ignore SSL certificate errors
const agent = new https.Agent({
    rejectUnauthorized: false
});

let MAIN_URL = "https://hdhub4u.frl"; // Default domain
const DOMAINS_URL = "https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json";

// --- Caching Configuration ---
const CACHE_ENABLED = process.env.DISABLE_CACHE !== 'true';
console.log(`[HDHub4u Cache] Internal cache is ${CACHE_ENABLED ? 'enabled' : 'disabled'}.`);
const CACHE_DIR = process.env.VERCEL ? path.join('/tmp', '.hdhub4u_cache') : path.join(__dirname, '.cache', 'hdhub4u');
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Initialize Redis cache
const redisCache = new RedisCache('HDHub4u');

// --- Caching Helper Functions ---
const ensureCacheDir = async () => {
    if (!CACHE_ENABLED) return;
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') {
            console.error(`[HDHub4u Cache] Error creating cache directory: ${error.message}`);
        }
    }
};

const getFromCache = async (key) => {
    if (!CACHE_ENABLED) return null;

    // Try Redis cache first, then fallback to file system
    const cachedData = await redisCache.getFromCache(key, '', CACHE_DIR);
    if (cachedData) {
        console.log(`[HDHub4u Cache] HIT for key: ${key}`);
        return cachedData.data || cachedData; // Support both new format (data field) and legacy format
    }

    console.log(`[HDHub4u Cache] MISS for key: ${key}`);
    return null;
};

const saveToCache = async (key, data) => {
    if (!CACHE_ENABLED) return;

    const cacheData = {
        data: data
    };

    // Save to both Redis and file system
    await redisCache.saveToCache(key, cacheData, '', CACHE_DIR);
    console.log(`[HDHub4u Cache] SAVED for key: ${key}`);
};

// Initialize cache directory on startup
ensureCacheDir();

// --- Proxy Configuration ---
const HDHUB4U_PROXY_URL = process.env.HDHUB4U_PROXY_URL;
if (HDHUB4U_PROXY_URL) {
    console.log(`[HDHub4u] Proxy support enabled: ${HDHUB4U_PROXY_URL}`);
} else {
    console.log('[HDHub4u] No proxy configured, using direct connections');
}

/**
 * Fetches the latest domain for HDHub4u.
 */
async function fetchAndUpdateDomain() {
    try {
        const response = await makeRequest(DOMAINS_URL, { httpsAgent: agent });
        if (response.data && response.data.HDHUB4u) {
            const newDomain = response.data.HDHUB4u;
            if (newDomain !== MAIN_URL) {
                console.log(`[HDHub4u] Updating domain from ${MAIN_URL} to ${newDomain}`);
                MAIN_URL = newDomain;
                HEADERS.Referer = `${MAIN_URL}/`;
            }
        }
    } catch (e) {
        console.error("[HDHub4u] Failed to fetch latest domains, using default.", e.message);
    }
}

const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    "Cookie": "xla=s4t",
    "Referer": `${MAIN_URL}/`,
};

// --- Proxy Wrapper Function ---
const makeRequest = async (url, options = {}) => {
    if (HDHUB4U_PROXY_URL) {
        const proxiedUrl = `${HDHUB4U_PROXY_URL}?url=${encodeURIComponent(url)}`;
        console.log(`[HDHub4u] Using proxy for: ${url}`);
        return axios.get(proxiedUrl, options);
    } else {
        return axios.get(url, options);
    }
};

// =================================================================================
// UTILITY FUNCTIONS
// =================================================================================

/**
 * Applies a ROT13 cipher to a string.
 */
function rot13(value) {
    return value.replace(/[a-zA-Z]/g, function (c) {
        return String.fromCharCode((c <= "Z" ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26);
    });
}

/**
 * Base64 encodes a string.
 */
function btoa(value) {
    return Buffer.from(value).toString('base64');
}

/**
 * Base64 decodes a string.
 */
function atob(value) {
    return Buffer.from(value, 'base64').toString('utf-8');
}

/**
 * Cleans title by extracting quality and codec information.
 */
function cleanTitle(title) {
    const parts = title.split(/[.\-_]/);

    const qualityTags = [
        "WEBRip", "WEB-DL", "WEB", "BluRay", "HDRip", "DVDRip", "HDTV",
        "CAM", "TS", "R5", "DVDScr", "BRRip", "BDRip", "DVD", "PDTV", "HD"
    ];

    const audioTags = [
        "AAC", "AC3", "DTS", "MP3", "FLAC", "DD5", "EAC3", "Atmos"
    ];
    const subTags = [
        "ESub", "ESubs", "Subs", "MultiSub", "NoSub", "EnglishSub", "HindiSub"
    ];

    const codecTags = [
        "x264", "x265", "H264", "HEVC", "AVC"
    ];

    const startIndex = parts.findIndex(part =>
        qualityTags.some(tag => part.toLowerCase().includes(tag.toLowerCase()))
    );

    const endIndex = parts.findLastIndex(part =>
        subTags.some(tag => part.toLowerCase().includes(tag.toLowerCase())) ||
        audioTags.some(tag => part.toLowerCase().includes(tag.toLowerCase())) ||
        codecTags.some(tag => part.toLowerCase().includes(tag.toLowerCase()))
    );

    if (startIndex !== -1 && endIndex !== -1 && endIndex >= startIndex) {
        return parts.slice(startIndex, endIndex + 1).join(".");
    } else if (startIndex !== -1) {
        return parts.slice(startIndex).join(".");
    } else {
        return parts.slice(-3).join(".");
    }
}

/**
 * Resolves obfuscated redirector links.
 */
async function getRedirectLinks(url) {
    try {
        console.log(`[HDHub4u] Processing redirect link: ${url}`);
        const response = await makeRequest(url, { headers: HEADERS, httpsAgent: agent });
        const doc = response.data;

        // Log response details for debugging
        console.log(`[HDHub4u] Response status: ${response.status}`);
        console.log(`[HDHub4u] Response headers:`, JSON.stringify(response.headers, null, 2));
        console.log(`[HDHub4u] Page content length: ${doc.length}`);
        console.log(`[HDHub4u] Page content preview (first 500 chars):`, doc.substring(0, 500));
        console.log(`[HDHub4u] Page content preview (last 500 chars):`, doc.substring(Math.max(0, doc.length - 500)));

        const regex = /s\('o','([A-Za-z0-9+/=]+)'|ck\('_wp_http_\d+','([^']+)'/g;
        let combinedString = '';
        let match;
        let matchCount = 0;
        while ((match = regex.exec(doc)) !== null) {
            const extractedValue = match[1] || match[2];
            if (extractedValue) {
                combinedString += extractedValue;
                matchCount++;
                console.log(`[HDHub4u] Found match ${matchCount}: ${extractedValue.substring(0, 50)}...`);
            }
        }

        console.log(`[HDHub4u] Total matches found: ${matchCount}`);
        console.log(`[HDHub4u] Combined string length: ${combinedString.length}`);

        if (!combinedString) {
            console.error("[HDHub4u] Could not find encoded strings in page.");

            // Check if this is an "Invalid Link" response from techyboy4u
            if (doc.trim() === "Invalid Link !!") {
                console.log('[HDHub4u] Techyboy4u returned "Invalid Link" - link may be expired or blocked');
                return null; // Return null to indicate complete failure
            }

            console.log('[HDHub4u] Searching for alternative patterns...');

            // Try alternative patterns
            const altPatterns = [
                /btoa\("([^"]+)"\)/g,
                /atob\("([^"]+)"\)/g,
                /btoa\('([^']+)'\)/g,
                /atob\('([^']+)'\)/g,
                /"([A-Za-z0-9+\/=]{20,})"/g,
                /'([A-Za-z0-9+\/=]{20,})'/g
            ];

            for (let i = 0; i < altPatterns.length; i++) {
                const altRegex = altPatterns[i];
                const altMatches = [];
                let altMatch;
                while ((altMatch = altRegex.exec(doc)) !== null) {
                    altMatches.push(altMatch[1]);
                }
                console.log(`[HDHub4u] Alternative pattern ${i + 1} (${altRegex}) found ${altMatches.length} matches`);
                if (altMatches.length > 0) {
                    console.log(`[HDHub4u] Sample matches:`, altMatches.slice(0, 3));
                }
            }

            return null; // Return null instead of original URL for failed redirects
        }

        const decodedString = atob(rot13(atob(atob(combinedString))));
        const jsonObject = JSON.parse(decodedString);

        const encodedUrl = atob(jsonObject.o || '').trim();
        if (encodedUrl) {
            return encodedUrl;
        }

        const data = btoa(jsonObject.data || '').trim();
        const wpHttp = (jsonObject.blog_url || '').trim();
        if (wpHttp && data) {
            const directLinkResponse = await makeRequest(`${wpHttp}?re=${data}`, { headers: HEADERS, httpsAgent: agent });
            const $ = cheerio.load(directLinkResponse.data);
            return $('body').text().trim();
        }

        return url;
    } catch (e) {
        console.error(`[HDHub4u] Error processing link ${url}:`, e.message);
        return url;
    }
}

// =================================================================================
// EXTRACTORS
// =================================================================================

/**
 * Main extractor dispatcher.
 */
async function loadExtractor(url, referer = MAIN_URL) {
    const hostname = new URL(url).hostname;

    // Some links from the main site are redirectors that need to be resolved first.
    if (url.includes("?id=") || hostname.includes('techyboy4u')) {
        console.log(`[HDHub4u] Processing redirect URL: ${url} (hostname: ${hostname})`);
        const finalLink = await getRedirectLinks(url);
        if (!finalLink) {
            console.log(`[HDHub4u] Failed to resolve redirect link: ${url}`);
            return [];
        }
        console.log(`[HDHub4u] Redirect resolved to: ${finalLink}`);
        return loadExtractor(finalLink, url);
    }

    if (hostname.includes('hubcloud')) {
        return hubCloudExtractor(url, referer);
    }
    if (hostname.includes('hubdrive')) {
        return hubDriveExtractor(url, referer);
    }
    if (hostname.includes('hubcdn')) {
        return hubCdnExtractor(url, referer);
    }
    if (hostname.includes('hblinks')) {
        return hbLinksExtractor(url, referer);
    }
    if (hostname.includes('hubstream')) {
        return hubStreamExtractor(url, referer);
    }
    if (hostname.includes('pixeldrain')) {
        return pixelDrainExtractor(url);
    }
    if (hostname.includes('streamtape')) {
        return streamTapeExtractor(url);
    }
    if (hostname.includes('hdstream4u')) {
        return [{ source: 'HdStream4u', quality: 'Unknown', url }];
    }

    // Skip unsupported hosts
    if (hostname.includes('linkrit')) {
        return [];
    }

    // Default case for unknown extractors
    const sourceName = hostname.replace(/^www\./, '');
    return [{ source: sourceName, quality: 'Unknown', url }];
}

/**
 * Extract direct download link from Pixeldrain.
 */
async function pixelDrainExtractor(link) {
    try {
        let fileId;
        const match = link.match(/(?:file|u)\/([A-Za-z0-9]+)/);
        if (match) {
            fileId = match[1];
        } else {
            fileId = link.split('/').pop();
        }
        if (!fileId) {
            return [{ source: 'Pixeldrain', quality: 'Unknown', url: link }];
        }

        const infoUrl = `https://pixeldrain.com/api/file/${fileId}/info`;
        let fileInfo = { name: '', quality: 'Unknown', size: 0 };

        try {
            const { data: info } = await makeRequest(infoUrl, { httpsAgent: agent });
            if (info && info.name) {
                fileInfo.name = info.name;
                fileInfo.size = info.size || 0;

                const qualityMatch = info.name.match(/(\d{3,4})p/);
                if (qualityMatch) {
                    fileInfo.quality = qualityMatch[0];
                }
            }
        } catch (e) {
            console.warn(`[HDHub4u] Could not fetch file info for ${fileId}:`, e.message);
        }

        const directUrl = `https://pixeldrain.com/api/file/${fileId}?download`;
        return [{
            source: 'Pixeldrain',
            quality: fileInfo.quality,
            url: directUrl,
            name: fileInfo.name,
            size: fileInfo.size,
        }];
    } catch (e) {
        console.error('[HDHub4u] Pixeldrain extraction failed', e.message);
        return [{ source: 'Pixeldrain', quality: 'Unknown', url: link }];
    }
}

/**
 * Extract streamable URL from StreamTape.
 */
async function streamTapeExtractor(link) {
    const url = new URL(link);
    url.hostname = 'streamtape.com';
    const normalizedLink = url.toString();

    try {
        const res = await makeRequest(normalizedLink, { headers: HEADERS, httpsAgent: agent });

        const match = res.data.match(/document\.getElementById\('videolink'\)\.innerHTML = (.*?);/);

        if (match && match[1]) {
            const scriptContent = match[1];
            const urlPartMatch = scriptContent.match(/'(\/\/streamtape\.com\/get_video[^']+)'/);

            if (urlPartMatch && urlPartMatch[1]) {
                const videoSrc = 'https:' + urlPartMatch[1];
                return [{ source: 'StreamTape', quality: 'Stream', url: videoSrc }];
            }
        }

        const simpleMatch = res.data.match(/'(\/\/streamtape\.com\/get_video[^']+)'/);
        if (simpleMatch && simpleMatch[0]) {
            const videoSrc = 'https:' + simpleMatch[0].slice(1, -1);
            return [{ source: 'StreamTape', quality: 'Stream', url: videoSrc }];
        }

        return [];
    } catch (e) {
        if (!e.response || e.response.status !== 404) {
            console.error(`[HDHub4u] StreamTape error for ${normalizedLink}:`, e.message);
        }
        return [];
    }
}

async function hubStreamExtractor(url, referer) {
    try {
        const response = await makeRequest(url, { headers: { ...HEADERS, Referer: referer }, httpsAgent: agent });
        return [{ source: 'Hubstream', quality: 'Unknown', url }];
    } catch (e) {
        console.error(`[HDHub4u] Hubstream failed to extract from ${url}:`, e.message);
        return [];
    }
}

async function hbLinksExtractor(url, referer) {
    const response = await makeRequest(url, { headers: { ...HEADERS, Referer: referer }, httpsAgent: agent });
    const $ = cheerio.load(response.data);
    const links = $('h3 a, div.entry-content p a').map((i, el) => $(el).attr('href')).get();

    const finalLinks = [];
    for (const link of links) {
        const extracted = await loadExtractor(link, url);
        finalLinks.push(...extracted);
    }
    return finalLinks;
}

async function hubCdnExtractor(url, referer) {
    const response = await makeRequest(url, { headers: { ...HEADERS, Referer: referer }, httpsAgent: agent });
    const encodedMatch = response.data.match(/r=([A-Za-z0-9+/=]+)/);
    if (encodedMatch && encodedMatch[1]) {
        const m3u8Data = atob(encodedMatch[1]);
        const m3u8Link = m3u8Data.substring(m3u8Data.lastIndexOf('link=') + 5);
        return [{
            source: 'HubCdn',
            quality: 'M3U8',
            url: m3u8Link,
        }];
    }
    return [];
}

async function hubDriveExtractor(url, referer) {
    const response = await makeRequest(url, { headers: { ...HEADERS, Referer: referer }, httpsAgent: agent });
    const $ = cheerio.load(response.data);
    const href = $('.btn.btn-primary.btn-user.btn-success1.m-1').attr('href');
    if (href) {
        return loadExtractor(href, url);
    }
    return [];
}

async function hubCloudExtractor(url, referer) {
    let currentUrl = url;
    if (currentUrl.includes("hubcloud.ink")) {
        currentUrl = currentUrl.replace("hubcloud.ink", "hubcloud.dad");
    }

    let pageResponse = await makeRequest(currentUrl, { headers: { ...HEADERS, Referer: referer }, httpsAgent: agent });
    let finalUrl = currentUrl;

    if (!currentUrl.includes("hubcloud.php")) {
        const scriptUrlMatch = pageResponse.data.match(/var url = '([^']*)'/);
        if (scriptUrlMatch && scriptUrlMatch[1]) {
            finalUrl = scriptUrlMatch[1];
            pageResponse = await makeRequest(finalUrl, { headers: { ...HEADERS, Referer: currentUrl }, httpsAgent: agent });
        }
    }

    const $ = cheerio.load(pageResponse.data);
    const size = $('i#size').text().trim();
    const header = $('div.card-header').text().trim();

    const getIndexQuality = (str) => {
        const match = (str || '').match(/(\d{3,4})[pP]/);
        return match ? parseInt(match[1]) : 2160;
    };

    const quality = getIndexQuality(header);
    const headerDetails = cleanTitle(header);

    const labelExtras = (() => {
        let extras = '';
        if (headerDetails) extras += `[${headerDetails}]`;
        if (size) extras += `[${size}]`;
        return extras;
    })();

    const sizeInBytes = (() => {
        if (!size) return 0;
        const sizeMatch = size.match(/([\d.]+)\s*(GB|MB|KB)/i);
        if (!sizeMatch) return 0;

        const value = parseFloat(sizeMatch[1]);
        const unit = sizeMatch[2].toUpperCase();

        if (unit === 'GB') return value * 1024 * 1024 * 1024;
        if (unit === 'MB') return value * 1024 * 1024;
        if (unit === 'KB') return value * 1024;
        return 0;
    })();

    const links = [];
    const elements = $('div.card-body h2 a.btn').get();

    for (const element of elements) {
        const link = $(element).attr('href');
        const text = $(element).text();

        if (text.includes("Download File")) {
            links.push({ source: `HubCloud ${labelExtras}`, quality, url: link, size: sizeInBytes });
        } else if (text.includes("FSL Server")) {
            links.push({ source: `HubCloud - FSL Server ${labelExtras}`, quality, url: link, size: sizeInBytes });
        } else if (text.includes("S3 Server")) {
            links.push({ source: `HubCloud - S3 Server ${labelExtras}`, quality, url: link, size: sizeInBytes });
        } else if (text.includes("BuzzServer")) {
            try {
                const buzzResp = await makeRequest(`${link}/download`, {
                    headers: { ...HEADERS, Referer: link },
                    maxRedirects: 0,
                    validateStatus: status => status >= 200 && status < 400,
                    httpsAgent: agent,
                });
                const dlink = buzzResp.headers['hx-redirect'];
                if (dlink) {
                    const baseUrl = new URL(link).origin;
                    links.push({ source: `HubCloud - BuzzServer ${labelExtras}`, quality, url: baseUrl + dlink, size: sizeInBytes });
                }
            } catch (e) {
                if (e.response && e.response.headers['hx-redirect']) {
                    const dlink = e.response.headers['hx-redirect'];
                    const baseUrl = new URL(link).origin;
                    links.push({ source: `HubCloud - BuzzServer ${labelExtras}`, quality, url: baseUrl + dlink, size: sizeInBytes });
                } else {
                    console.error("[HDHub4u] BuzzServer redirect not found for", link);
                }
            }
        } else if (link.includes("pixeldra")) {
            links.push({ source: `Pixeldrain ${labelExtras}`, quality, url: link, size: sizeInBytes });
        } else if (text.includes("10Gbps")) {
            let currentRedirectUrl = link;
            let finalLink = null;
            for (let i = 0; i < 5; i++) {
                try {
                    const response = await makeRequest(currentRedirectUrl, { maxRedirects: 0, validateStatus: null, httpsAgent: agent });
                    const location = response.headers.location;
                    if (location) {
                        if (location.includes("link=")) {
                            finalLink = location.substring(location.indexOf("link=") + 5);
                            break;
                        }
                        currentRedirectUrl = new URL(location, currentRedirectUrl).toString();
                    } else {
                        break;
                    }
                } catch (e) {
                    if (e.response && e.response.headers.location) {
                        const location = e.response.headers.location;
                        if (location.includes("link=")) {
                            finalLink = location.substring(location.indexOf("link=") + 5);
                            break;
                        }
                        currentRedirectUrl = new URL(location, currentRedirectUrl).toString();
                    } else {
                        console.error("[HDHub4u] 10Gbps redirect failed for", currentRedirectUrl);
                        break;
                    }
                }
            }
            if (finalLink) {
                links.push({ source: `HubCloud - 10Gbps ${labelExtras}`, quality, url: finalLink, size: sizeInBytes });
            }
        } else {
            const extracted = await loadExtractor(link, finalUrl);
            links.push(...extracted);
        }
    }
    return links;
}

// =================================================================================
// MAIN PROVIDER LOGIC
// =================================================================================

/**
 * Searches for media on HDHub4u.
 */
async function search(query) {
    await fetchAndUpdateDomain();
    // Use /?s= (WordPress search) which returns static HTML
    // The /search.html?q= uses a JavaScript-based Typesense API which is blocked by Cloudflare for server requests
    const searchUrl = `${MAIN_URL}/?s=${encodeURIComponent(query)}`;
    console.log(`[HDHub4u] Searching with URL: ${searchUrl}`);
    const response = await makeRequest(searchUrl, { headers: HEADERS, httpsAgent: agent });
    console.log(`[HDHub4u] Search response status: ${response.status}`);
    const $ = cheerio.load(response.data);

    // Try multiple selectors for search results
    let results = [];

    // Selector 1: WordPress figcaption layout (primary structure from curl investigation)
    // Structure: <figure><img></figure><figcaption><a href><p>Title</p></a></figcaption>
    $('figcaption').each((i, el) => {
        const element = $(el);
        const linkEl = element.find('a').first();
        const url = linkEl.attr('href');
        const title = linkEl.find('p').text().trim() || linkEl.text().trim();
        // Get poster from sibling figure element
        const poster = element.prev('figure').find('img').attr('src') || element.parent().find('figure img').attr('src');

        if (title && url && url.length > 10) {
            results.push({ title, url, poster });
        }
    });

    // Selector 2: thumbnail-wrapper layout (some WordPress themes)
    if (results.length === 0) {
        $('.thumbnail-wrapper, .thumb-wrapper, li.thumb').each((i, el) => {
            const element = $(el);
            const linkEl = element.find('figcaption a, a').first();
            const url = linkEl.attr('href');
            const title = linkEl.find('p').text().trim() || linkEl.text().trim();
            const poster = element.find('figure img, img').first().attr('src');

            if (title && url && url.length > 10) {
                const absoluteUrl = url.startsWith('http') ? url : `${MAIN_URL}${url.startsWith('/') ? '' : '/'}${url}`;
                results.push({ title, url: absoluteUrl, poster });
            }
        });
    }

    // Selector 3: HDHub4u movie-grid layout (for /search.html page if it somehow works)
    if (results.length === 0) {
        $('ul.movie-grid li.movie-card, ul#results-grid li.movie-card').each((i, el) => {
            const element = $(el);
            const linkEl = element.find('> a').first();
            const url = linkEl.attr('href');
            const title = linkEl.find('h3.movie-title').text().trim() || linkEl.find('h3').text().trim();
            const poster = linkEl.find('img').attr('src') || linkEl.find('img').attr('data-src');

            if (title && url) {
                const absoluteUrl = url.startsWith('http') ? url : `${MAIN_URL}${url.startsWith('/') ? '' : '/'}${url}`;
                results.push({ title, url: absoluteUrl, poster });
            }
        });
    }

    // Selector 4: Standard article-based layout
    if (results.length === 0) {
        $('article, .post, .result-item, .search-result').each((i, el) => {
            const element = $(el);
            const titleEl = element.find('h3 a, h2 a, .entry-title a, a.title').first();
            const title = titleEl.text().trim() || element.find('h3, h2, .entry-title').first().text().trim();
            const url = titleEl.attr('href') || element.find('a').first().attr('href');
            const poster = element.find('img').first().attr('src') || element.find('img').first().attr('data-src');

            if (title && url) {
                const absoluteUrl = url.startsWith('http') ? url : `${MAIN_URL}${url.startsWith('/') ? '' : '/'}${url}`;
                results.push({ title, url: absoluteUrl, poster });
            }
        });
    }


    // Deduplicate by URL
    const seenUrls = new Set();
    results = results.filter(r => {
        if (!r.url || seenUrls.has(r.url)) return false;
        seenUrls.add(r.url);
        return true;
    });

    console.log(`[HDHub4u] Parsed ${results.length} search results`);
    if (results.length > 0) {
        console.log(`[HDHub4u] First result: ${results[0].title} - ${results[0].url}`);
    }

    return results;
}

/**
 * Fetches the media page and extracts all hoster links.
 */
async function getDownloadLinks(mediaUrl) {
    await fetchAndUpdateDomain();
    HEADERS.Referer = `${MAIN_URL}/`;
    console.log(`[HDHub4u] Fetching download links from: ${mediaUrl}`);
    const response = await makeRequest(mediaUrl, { headers: HEADERS, httpsAgent: agent });
    console.log(`[HDHub4u] Download page response status: ${response.status}`);
    const $ = cheerio.load(response.data);

    const typeRaw = $('h1.page-title span').text();
    const isMovie = typeRaw.toLowerCase().includes('movie');

    const title = $('.page-body h2[data-ved="2ahUKEwjL0NrBk4vnAhWlH7cAHRCeAlwQ3B0oATAfegQIFBAM"], h2[data-ved="2ahUKEwiP0pGdlermAhUFYVAKHV8tAmgQ3B0oATAZegQIDhAM"]').text();
    const seasonMatch = title.match(/\bSeason\s*(\d+)\b/i);
    const seasonNumber = seasonMatch ? parseInt(seasonMatch[1]) : null;

    let initialLinks = [];

    if (isMovie) {
        const qualityLinks = $('h3 a, h4 a').filter((i, el) => {
            const linkText = $(el).text();
            return linkText.match(/480|720|1080|2160|4K/i);
        });

        initialLinks = qualityLinks.map((i, el) => ({ url: $(el).attr('href') })).get();

        const seen = new Set();
        initialLinks = initialLinks.filter(link => {
            if (!link.url || seen.has(link.url)) {
                return false;
            }
            seen.add(link.url);
            return true;
        });

    } else { // TV Series
        const episodeLinksMap = new Map();

        $('h3 a, h4 a').each((i, element) => {
            const $el = $(element);
            const text = $el.text();
            const href = $el.attr('href');

            if (text.match(/1080|720|4K|2160/i) && href) {
                if (href.includes('techyboy4u.com')) {
                    console.log(`[HDHub4u] Found techyboy4u quality redirect link: ${href} (text: ${text})`);
                    initialLinks.push({ url: href, isQualityRedirect: true, priority: 1 });
                } else {
                    console.log(`[HDHub4u] Found alternative quality link: ${href} (text: ${text})`);
                    initialLinks.push({ url: href, isQualityRedirect: false, priority: 2 });
                }
            }
        });

        $('h4').each((i, element) => {
            const $el = $(element);
            const text = $el.text();
            const episodeMatch = text.match(/(?:EPiSODE\s*(\d+)|E(\d+))/i);

            if (episodeMatch) {
                const epNum = parseInt(episodeMatch[1] || episodeMatch[2]);
                if (!episodeLinksMap.has(epNum)) episodeLinksMap.set(epNum, []);

                const links = $el.find('a').map((i, a) => $(a).attr('href')).get();
                episodeLinksMap.get(epNum).push(...links);
            }
        });

        if (episodeLinksMap.size === 0) {
            for (const element of $('h3, h4').get()) {
                const $el = $(element);
                const title = $el.text();
                const episodeMatch = title.match(/(?:EPiSODE\s*(\d+)|E(\d+))/i);
                const epNum = episodeMatch ? parseInt(episodeMatch[1] || episodeMatch[2]) : null;

                const isDirectLinkBlock = $el.find('a').text().match(/1080|720|4K|2160/i);

                if (isDirectLinkBlock) {
                    const redirectLinks = $el.find('a').map((i, a) => $(a).attr('href')).get();
                    for (const redirectLink of redirectLinks) {
                        try {
                            const resolvedUrl = await getRedirectLinks(redirectLink);
                            const episodeDocPage = await makeRequest(resolvedUrl, { headers: HEADERS, httpsAgent: agent });
                            const $$ = cheerio.load(episodeDocPage.data);
                            $$('h5 a').each((i, linkEl) => {
                                const linkText = $$(linkEl).text();
                                const linkHref = $$(linkEl).attr('href');
                                const innerEpMatch = linkText.match(/Episode\s*(\d+)/i);
                                if (innerEpMatch && linkHref) {
                                    const innerEpNum = parseInt(innerEpMatch[1]);
                                    if (!episodeLinksMap.has(innerEpNum)) episodeLinksMap.set(innerEpNum, []);
                                    episodeLinksMap.get(innerEpNum).push(linkHref);
                                }
                            });
                        } catch (e) {
                            console.error(`[HDHub4u] Error resolving direct link block: ${redirectLink}`, e.message);
                        }
                    }

                } else if (epNum) {
                    if (!episodeLinksMap.has(epNum)) episodeLinksMap.set(epNum, []);

                    const baseLinks = $el.find('a').map((i, a) => $(a).attr('href')).get();
                    episodeLinksMap.get(epNum).push(...baseLinks);

                    let nextElement = $el.next();
                    while (nextElement.length && nextElement.get(0).tagName !== 'hr' && nextElement.get(0).tagName !== 'h3' && nextElement.get(0).tagName !== 'h4') {
                        const siblingLinks = nextElement.find('a').map((i, a) => $(a).attr('href')).get();
                        episodeLinksMap.get(epNum).push(...siblingLinks);
                        nextElement = nextElement.next();
                    }
                }
            }
        }

        episodeLinksMap.forEach((links, epNum) => {
            const uniqueLinks = [...new Set(links)];
            initialLinks.push(...uniqueLinks.map(link => ({ url: link, episode: epNum })));
        });
    }

    console.log(`[HDHub4u] Found ${initialLinks.length} initial hoster links. Now extracting...`);

    const allFinalLinks = [];
    const promises = initialLinks.map(async (linkInfo) => {
        try {
            if (linkInfo.isQualityRedirect) {
                const resolvedUrl = await getRedirectLinks(linkInfo.url);
                const episodeDocPage = await makeRequest(resolvedUrl, { headers: HEADERS, httpsAgent: agent });
                const $$ = cheerio.load(episodeDocPage.data);

                const episodeLinks = [];
                $$('h5 a').each((i, linkEl) => {
                    const linkText = $$(linkEl).text();
                    const linkHref = $$(linkEl).attr('href');
                    const episodeMatch = linkText.match(/Episode\s*(\d+)/i);
                    if (episodeMatch && linkHref) {
                        const epNum = parseInt(episodeMatch[1]);
                        episodeLinks.push({ url: linkHref, episode: epNum });
                    }
                });

                $$('h3 a').each((i, linkEl) => {
                    const linkHref = $$(linkEl).attr('href');
                    const linkText = $$(linkEl).text();
                    if (linkHref && !linkHref.includes('magnet:') && !linkHref.includes('.zip') && !linkText.toLowerCase().includes('pack')) {
                        episodeLinks.push({ url: linkHref, episode: null });
                    }
                });

                const episodePromises = episodeLinks.map(async (epLink) => {
                    try {
                        const extractedLinks = await loadExtractor(epLink.url, resolvedUrl);
                        return extractedLinks.map(finalLink => ({ ...finalLink, episode: epLink.episode }));
                    } catch (e) {
                        console.error(`[HDHub4u] Failed to extract episode link ${epLink.url}:`, e.message);
                        return [];
                    }
                });

                const episodeResults = await Promise.all(episodePromises);
                return episodeResults.flat();
            } else {
                const extractedLinks = await loadExtractor(linkInfo.url, mediaUrl);
                return extractedLinks.map(finalLink => ({ ...finalLink, episode: linkInfo.episode }));
            }
        } catch (e) {
            console.error(`[HDHub4u] Failed to extract from ${linkInfo.url}:`, e.message);
            return [];
        }
    });

    const results = await Promise.all(promises);
    results.forEach(res => allFinalLinks.push(...res));

    const seenUrls = new Set();
    const uniqueFinalLinks = allFinalLinks.filter(link => {
        if (link.url && (link.url.includes('.zip') || (link.name && link.name.toLowerCase().includes('.zip')))) {
            return false;
        }
        if (seenUrls.has(link.url)) {
            return false;
        }
        seenUrls.add(link.url);
        return true;
    });

    return { finalLinks: uniqueFinalLinks, isMovie };
}

// Helper function to convert quality string to numeric value for sorting
function parseQualityForSort(qualityString) {
    if (!qualityString) return 0;
    // Handle both string and number inputs
    if (typeof qualityString === 'number') return qualityString;
    if (typeof qualityString !== 'string') return 0;
    const match = qualityString.match(/(\d{3,4})/);
    return match ? parseInt(match[1], 10) : 0;
}

// Helper function to format file size
function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Main function to get streams for TMDB content
 */
async function getHDHub4uStreams(tmdbId, mediaType, title, year = null, seasonNum = null, episodeNum = null) {
    try {
        console.log(`[HDHub4u] ===== STARTING STREAM FETCH =====`);
        console.log(`[HDHub4u] Fetching streams for "${title}" (${year}) - TMDB ${mediaType}/${tmdbId}${seasonNum ? `, S${seasonNum}E${episodeNum}` : ''}`);
        console.log(`[HDHub4u] TMDB ID: ${tmdbId}`);
        console.log(`[HDHub4u] Current domain: ${MAIN_URL}`);

        // Update domain before starting
        await fetchAndUpdateDomain();

        // Define cache key
        const cacheKey = `hdhub4u_final_v1_${mediaType}_${tmdbId}${seasonNum ? `_s${seasonNum}` : ''}${episodeNum ? `_e${episodeNum}` : ''}`;
        console.log(`[HDHub4u] Cache key: ${cacheKey}`);

        // Try to get from cache first
        const cachedData = await getFromCache(cacheKey);
        if (cachedData && cachedData.length > 0) {
            console.log(`[HDHub4u] Returning ${cachedData.length} cached streams`);
            return cachedData;
        } else if (cachedData && cachedData.length === 0) {
            console.log(`[HDHub4u] Cache contains empty data for ${cacheKey}. Refetching from source.`);
        }

        // Use the title parameter passed from addon.js (no need for redundant TMDB call)
        if (!title) {
            console.log(`[HDHub4u] No title provided for ${mediaType}/${tmdbId}`);
            return [];
        }

        // Search strategy: search for just the title first (more results), then filter by season
        // This works better than searching with "season X" appended
        let searchQuery = title;
        console.log(`[HDHub4u] Searching for: "${searchQuery}"`);

        // Search for content
        let searchResults = await search(searchQuery);
        console.log(`[HDHub4u] Search returned ${searchResults.length} results for query: ${searchQuery}`);

        // If no results, try with year appended
        if (searchResults.length === 0 && year) {
            searchQuery = `${title} ${year}`;
            console.log(`[HDHub4u] Retrying search with year: "${searchQuery}"`);
            searchResults = await search(searchQuery);
            console.log(`[HDHub4u] Retry search returned ${searchResults.length} results`);
        }

        if (searchResults.length === 0) {
            console.log(`[HDHub4u] No search results found for "${title}"`);
            await saveToCache(cacheKey, []);
            return [];
        }

        // Log first few search results
        searchResults.slice(0, 5).forEach((result, index) => {
            console.log(`[HDHub4u] Search result ${index + 1}: ${result.title} - ${result.url}`);
        });

        // Find best match - for TV shows, prioritize season match
        let bestMatch = null;
        if (mediaType === 'tv' && seasonNum) {
            // Look for exact season match in title first
            const seasonPattern = new RegExp(`season\\s*${seasonNum}|s${seasonNum}\\b|\\(season\\s*${seasonNum}\\)`, 'i');
            const seasonMatches = searchResults.filter(r => seasonPattern.test(r.title));

            if (seasonMatches.length > 0) {
                console.log(`[HDHub4u] Found ${seasonMatches.length} results matching Season ${seasonNum}`);
                bestMatch = seasonMatches[0];
            } else {
                // No exact season match, use title similarity
                console.log(`[HDHub4u] No exact season match found, using title similarity`);
                const titles = searchResults.map(r => r.title);
                const match = findBestMatch(title.toLowerCase(), titles.map(t => t.toLowerCase()));
                if (match.bestMatch.rating > 0.3) {
                    bestMatch = searchResults[match.bestMatchIndex];
                } else {
                    bestMatch = searchResults[0];
                }
            }
        } else if (searchResults.length === 1) {
            bestMatch = searchResults[0];
        } else {
            const titles = searchResults.map(r => r.title);
            const match = findBestMatch(searchQuery.toLowerCase(), titles.map(t => t.toLowerCase()));
            if (match.bestMatch.rating > 0.3) {
                bestMatch = searchResults[match.bestMatchIndex];
            } else {
                bestMatch = searchResults[0]; // Fallback to first result
            }
        }

        console.log(`[HDHub4u] ===== SELECTED MEDIA =====`);
        console.log(`[HDHub4u] Selected: "${bestMatch.title}" - ${bestMatch.url}`);
        console.log(`[HDHub4u] ===== EXTRACTING DOWNLOAD LINKS =====`);

        // Get download links
        const { finalLinks, isMovie } = await getDownloadLinks(bestMatch.url);

        if (finalLinks.length === 0) {
            console.log(`[HDHub4u] No download links found`);
            await saveToCache(cacheKey, []);
            return [];
        }

        // Filter links for specific episode if needed
        let filteredLinks = finalLinks;
        if (!isMovie && episodeNum) {
            filteredLinks = finalLinks.filter(link => link.episode === episodeNum);
        }

        // Convert to Stremio stream format and filter out unknown quality streams
        const streams = filteredLinks
            .map(link => {
                const quality = parseQualityForSort(link.quality) || 0;
                const sizeText = link.size ? formatBytes(link.size) : '';

                return {
                    quality: quality,
                    sizeText: sizeText,
                    link: link
                };
            })
            .filter(item => item.quality > 0) // Exclude streams with unknown/invalid quality
            .map(item => {
                const { quality, sizeText, link } = item;

                // Create abbreviated source names
                const sourceAbbrev = link.source.includes('Pixeldrain') ? 'PD' :
                    link.source.includes('HubCloud') ? 'HC' :
                        link.source.substring(0, 2).toUpperCase();

                // Simple title without verbose source information
                let title = `${quality}p`;
                if (link.episode) title += ` - Episode ${link.episode}`;

                return {
                    name: `HDHub4u-${quality}p | ${sourceAbbrev}`,
                    title: title,
                    url: link.url,
                    quality: quality.toString(),
                    provider: 'HDHub4u',
                    source: link.source,
                    size: sizeText,
                    episode: link.episode || null,
                    originalTitle: title // Store original title for fallback
                };
            });

        // Group streams by source and quality, then validate and select best link
        const streamGroups = new Map();

        // Group streams by quality + source type to allow both HubCloud and Pixeldrain
        for (const stream of streams) {
            const sourceType = stream.source.includes('HubCloud') ? 'HubCloud' :
                stream.source.includes('Pixeldrain') ? 'Pixeldrain' : 'Other';
            const groupKey = `${stream.quality}_${sourceType}`;
            if (!streamGroups.has(groupKey)) {
                streamGroups.set(groupKey, []);
            }
            streamGroups.get(groupKey).push(stream);
        }

        // Sort streams within each group by preference (10Gbps > regular, larger size > smaller)
        for (const [groupKey, groupStreams] of streamGroups) {
            groupStreams.sort((a, b) => {
                // Prefer 10Gbps variants
                const aIs10Gbps = a.source.includes('10Gbps');
                const bIs10Gbps = b.source.includes('10Gbps');
                if (aIs10Gbps !== bIs10Gbps) return bIs10Gbps ? 1 : -1;

                // Then prefer larger file sizes
                const aSize = parseFloat(a.size?.replace(/[^0-9.]/g, '') || '0');
                const bSize = parseFloat(b.size?.replace(/[^0-9.]/g, '') || '0');
                return bSize - aSize;
            });
        }

        // Helper function to extract filename from headers or URL
        const extractFilename = (headers, url) => {
            // First try Content-Disposition header
            const contentDisposition = headers['content-disposition'];
            if (contentDisposition) {
                // Try multiple patterns for Content-Disposition
                const patterns = [
                    /filename[^;=\n]*=(['"]?)([^'"\n]*?)\1/i,
                    /filename\*=UTF-8''([^;\n]*)/i,
                    /filename=([^;\n]*)/i
                ];

                for (const pattern of patterns) {
                    const match = contentDisposition.match(pattern);
                    if (match && match[2]) {
                        try {
                            return decodeURIComponent(match[2].trim());
                        } catch (e) {
                            return match[2].trim();
                        }
                    } else if (match && match[1]) {
                        try {
                            return decodeURIComponent(match[1].trim());
                        } catch (e) {
                            return match[1].trim();
                        }
                    }
                }
            }

            // Fallback to URL path extraction
            try {
                const urlPath = new URL(url).pathname;
                const pathSegments = urlPath.split('/');
                const lastSegment = pathSegments[pathSegments.length - 1];

                // Check if it looks like a filename (has extension)
                if (lastSegment && lastSegment.includes('.') && lastSegment.length > 3) {
                    return decodeURIComponent(lastSegment);
                }

                // Try to find any segment that looks like a filename
                for (let i = pathSegments.length - 1; i >= 0; i--) {
                    const segment = pathSegments[i];
                    if (segment && segment.includes('.') && segment.length > 3) {
                        return decodeURIComponent(segment);
                    }
                }
            } catch (error) {
                // URL parsing failed, continue
            }

            return null;
        };

        // Helper function to clean and format filename for display
        const formatFilenameTitle = (filename, originalTitle, size) => {
            if (!filename) return originalTitle;

            // Extract movie/show name and year from original title, removing quality prefix
            const cleanTitle = originalTitle.replace(/^\d+p\s*-?\s*/, ''); // Remove quality prefix like "1080p - "
            const titleMatch = cleanTitle.match(/^(.+?)\s+\((\d{4})\)/);
            if (titleMatch) {
                const [, movieName, year] = titleMatch;
                // Return in the format: "MovieName (Year) - FullFilename"
                return `${movieName} (${year}) - ${filename}`;
            }

            // Fallback: return filename with clean title (remove leading dash if present)
            const cleanedTitle = cleanTitle.replace(/^\s*-\s*/, ''); // Remove leading dash and spaces
            return cleanedTitle ? `${cleanedTitle} - ${filename}` : filename;
        };

        // Validate links in parallel for each group
        const validationPromises = Array.from(streamGroups.entries()).map(async ([groupKey, groupStreams]) => {
            console.log(`[HDHub4u] Validating ${groupStreams.length} links for ${groupKey}...`);

            // Create validation promises for all streams in this group
            const streamValidations = groupStreams.map(async (stream, index) => {
                try {
                    const response = await axios.head(stream.url, {
                        timeout: 5000,
                        httpsAgent: agent,
                        headers: {
                            'User-Agent': HEADERS['User-Agent']
                        }
                    });

                    if (response.status === 200) {
                        // Extract actual filename from headers or URL
                        const actualFilename = extractFilename(response.headers, stream.url);

                        console.log(`[HDHub4u] ✓ Link ${index + 1} validated for ${groupKey}${actualFilename ? ` - Filename: ${actualFilename}` : ''}`);

                        return {
                            ...stream,
                            actualFilename,
                            validationSuccess: true,
                            priority: index // Lower index = higher priority
                        };
                    }
                } catch (error) {
                    console.log(`[HDHub4u] ✗ Link ${index + 1} failed for ${groupKey}: ${error.message}`);
                }
                return null;
            });

            // Wait for all validations in this group to complete
            const results = await Promise.all(streamValidations);
            const validStreams = results.filter(result => result !== null);

            if (validStreams.length > 0) {
                // Return the highest priority valid stream
                const selectedStream = validStreams.sort((a, b) => a.priority - b.priority)[0];

                // Update title with actual filename if available
                if (selectedStream.actualFilename) {
                    selectedStream.title = formatFilenameTitle(
                        selectedStream.actualFilename,
                        selectedStream.originalTitle,
                        selectedStream.size
                    );
                }

                return selectedStream;
            } else if (groupStreams.length > 0) {
                console.log(`[HDHub4u] No working links found for ${groupKey}, using first as fallback`);
                const fallbackStream = groupStreams[0];

                // Try to extract filename for fallback stream too
                try {
                    const actualFilename = extractFilename({}, fallbackStream.url); // No headers, just URL
                    if (actualFilename) {
                        fallbackStream.title = formatFilenameTitle(
                            actualFilename,
                            fallbackStream.originalTitle,
                            fallbackStream.size
                        );
                    }
                } catch (error) {
                    // Filename extraction failed, keep original title
                }

                return fallbackStream;
            }

            return null;
        });

        // Wait for all group validations to complete
        console.log(`[HDHub4u] Starting parallel validation of ${streamGroups.size} groups...`);
        const validationResults = await Promise.all(validationPromises);
        const uniqueStreams = validationResults.filter(stream => stream !== null);

        // Sort by quality (highest first)
        uniqueStreams.sort((a, b) => {
            const qualityA = parseQualityForSort(a.quality);
            const qualityB = parseQualityForSort(b.quality);
            return qualityB - qualityA;
        });

        console.log(`[HDHub4u] Successfully extracted ${uniqueStreams.length} validated streams from ${streams.length} total streams (${streamGroups.size} unique quality/source combinations)`);

        // Cache the results
        await saveToCache(cacheKey, uniqueStreams);

        return uniqueStreams;

    } catch (error) {
        console.error(`[HDHub4u] Error in getHDHub4uStreams: ${error.message}`);
        return [];
    }
}

module.exports = {
    getHDHub4uStreams
};