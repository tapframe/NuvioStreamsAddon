/**
 * Standalone scraper for HDHub4u, replicating the CloudStream extension's logic.
 *
 * This script can search for media and extract the final download links by
 * following the same complex steps as the original Kotlin code.
 *
 * Original Kotlin source:
 * - HDhub4uProvider.kt: Main logic for fetching pages and parsing links.
 * - Extractors.kt: Custom extractors for hosts like HubCloud, Hubdrive, etc.
 * - Utils.kt: Obfuscation removal functions like getRedirectLinks.
 */

const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const readline = require('readline');

// Create an https agent to ignore SSL certificate errors
const agent = new https.Agent({
    rejectUnauthorized: false
});

let MAIN_URL = "https://hdhub4u.frl"; // Default domain

const DOMAINS_URL = "https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json";

/**
 * Fetches the latest domain for HDHub4u.
 * Replicates the `getDomains` function from the provider.
 */
async function fetchAndUpdateDomain() {
    try {
        const response = await axios.get(DOMAINS_URL, { httpsAgent: agent });
        if (response.data && response.data.HDHUB4u) {
            const newDomain = response.data.HDHUB4u;
            if (newDomain !== MAIN_URL) {
                console.log(`Updating domain from ${MAIN_URL} to ${newDomain}`);
                MAIN_URL = newDomain;
                HEADERS.Referer = `${MAIN_URL}/`;
            }
        }
    } catch (e) {
        console.error("Failed to fetch latest domains, using default.", e.message);
    }
}

/**
 * Gets the current domain, ensuring it's always up to date.
 * Should be called before any main site requests.
 */
async function getCurrentDomain() {
    try {
        const response = await axios.get(DOMAINS_URL, { httpsAgent: agent });
        if (response.data && response.data.HDHUB4u) {
            return response.data.HDHUB4u;
        }
    } catch (e) {
        console.error("Failed to fetch current domain, using cached.", e.message);
    }
    return MAIN_URL;
}

const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    "Cookie": "xla=s4t",
    "Referer": `${MAIN_URL}/`,
};

// =================================================================================
// UTILITY FUNCTIONS (from Utils.kt)
// =================================================================================

/**
 * Applies a ROT13 cipher to a string.
 * Replicates the `pen()` function from Utils.kt.
 * @param {string} value The input string.
 * @returns {string} The ROT13'd string.
 */
function rot13(value) {
    return value.replace(/[a-zA-Z]/g, function (c) {
        return String.fromCharCode((c <= "Z" ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26);
    });
}

/**
 * Base64 encodes a string.
 * Replicates `encode()` from Utils.kt.
 * @param {string} value The string to encode.
 * @returns {string} The base64 encoded string.
 */
function btoa(value) {
    return Buffer.from(value).toString('base64');
}

/**
 * Base64 decodes a string.
 * Replicates `base64Decode()` from cloudstream's utils.
 * @param {string} value The base64 string.
 * @returns {string} The decoded string.
 */
function atob(value) {
    return Buffer.from(value, 'base64').toString('utf-8');
}

/**
 * Cleans title by extracting quality and codec information.
 * Replicates the `cleanTitle` function from Utils.kt.
 * @param {string} title The title string to clean.
 * @returns {string} The cleaned title with quality/codec info.
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
 * Resolves obfuscated redirector links (e.g., hubdrive.fit/?id=...).
 * This is a direct translation of the `getRedirectLinks` function from `Utils.kt`.
 * @param {string} url The obfuscated URL.
 * @returns {Promise<string>} The resolved direct link.
 */
async function getRedirectLinks(url) {
    try {
        const response = await axios.get(url, { headers: HEADERS, httpsAgent: agent });
        const doc = response.data;

        const regex = /s\('o','([A-Za-z0-9+/=]+)'|ck\('_wp_http_\d+','([^']+)'/g;
        let combinedString = '';
        let match;
        while ((match = regex.exec(doc)) !== null) {
            const extractedValue = match[1] || match[2];
            if (extractedValue) {
                combinedString += extractedValue;
            }
        }

        if (!combinedString) {
            console.error("[getRedirectLinks] Could not find encoded strings in page.");
            return url;
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
            const directLinkResponse = await axios.get(`${wpHttp}?re=${data}`, { headers: HEADERS, httpsAgent: agent });
            const $ = cheerio.load(directLinkResponse.data);
            return $('body').text().trim();
        }

        return url; // Return original url if logic fails
    } catch (e) {
        console.error(`[getRedirectLinks] Error processing link ${url}:`, e.message);
        return url; // Fallback to original URL
    }
}

// =================================================================================
// EXTRACTORS (from Extractors.kt)
// =================================================================================

/**
 * Main extractor dispatcher. Determines which specific extractor to use based on the URL.
 * Replicates the `loadExtractor` logic flow.
 * @param {string} url The URL of the hoster page.
 * @param {string} referer The referer URL.
 * @returns {Promise<Array<{quality: string, url: string, source: string}>>} A list of final links.
 */
async function loadExtractor(url, referer = MAIN_URL) {
    const hostname = new URL(url).hostname;

    // Some links from the main site are redirectors that need to be resolved first.
    if (url.includes("?id=") || hostname.includes('techyboy4u')) {
        const finalLink = await getRedirectLinks(url);
        if (!finalLink) {
            return []; // Stop if redirect fails
        }
        // Recursively call loadExtractor with the new link
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
        // This is VidHidePro, often a simple redirect. For this script, we assume it's a direct link.
        return [{ source: 'HdStream4u', quality: 'Unknown', url }];
    }

    // Skip unsupported hosts like linkrit.com
    if (hostname.includes('linkrit')) {
        return [];
    }

    // Default case for unknown extractors, use the hostname as the source.
    const sourceName = hostname.replace(/^www\./, '');
    return [{ source: sourceName, quality: 'Unknown', url }];
}

/**
 * Extract direct download link from Pixeldrain.
 * Pixeldrain direct link format: https://pixeldrain.com/api/file/{id}?download
 */
async function pixelDrainExtractor(link) {
    try {
        let fileId;
        // link can be pixeldrain.com/u/{id} or pixeldrain.dev/... or pixeldrain.xyz/...
        const match = link.match(/(?:file|u)\/([A-Za-z0-9]+)/);
        if (match) {
            fileId = match[1];
        } else {
            fileId = link.split('/').pop();
        }
        if (!fileId) {
            return [{ source: 'Pixeldrain', quality: 'Unknown', url: link }];
        }

        // Fetch file info to get the name, size, and determine quality
        const infoUrl = `https://pixeldrain.com/api/file/${fileId}/info`;
        let fileInfo = { name: '', quality: 'Unknown', size: 0 };

        try {
            const { data: info } = await axios.get(infoUrl, { httpsAgent: agent });
            if (info && info.name) {
                fileInfo.name = info.name;
                fileInfo.size = info.size || 0;

                // Infer quality from filename
                const qualityMatch = info.name.match(/(\d{3,4})p/);
                if (qualityMatch) {
                    fileInfo.quality = qualityMatch[0];
                }
            }
        } catch (e) {
            console.warn(`[Pixeldrain] Could not fetch file info for ${fileId}:`, e.message);
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
        console.error('[Pixeldrain] extraction failed', e.message);
        return [{ source: 'Pixeldrain', quality: 'Unknown', url: link }];
    }
}

/**
 * Extract streamable URL from StreamTape.
 * This function normalizes the URL to streamtape.com and tries to find the direct video link.
 */
async function streamTapeExtractor(link) {
    // Streamtape has many domains, but .com is usually the most reliable for video pages.
    const url = new URL(link);
    url.hostname = 'streamtape.com';
    const normalizedLink = url.toString();

    try {
        const res = await axios.get(normalizedLink, { headers: HEADERS, httpsAgent: agent });

        // Regex to find something like: document.getElementById('videolink').innerHTML = ...
        const match = res.data.match(/document\.getElementById\('videolink'\)\.innerHTML = (.*?);/);

        if (match && match[1]) {
            const scriptContent = match[1];
            // The script might contain a direct URL part or a function call to build it. We look for the direct part.
            const urlPartMatch = scriptContent.match(/'(\/\/streamtape\.com\/get_video[^']+)'/);

            if (urlPartMatch && urlPartMatch[1]) {
                const videoSrc = 'https:' + urlPartMatch[1];
                return [{ source: 'StreamTape', quality: 'Stream', url: videoSrc }];
            }
        }

        // A simpler, secondary regex if the above fails (e.g., the script is not complex).
        const simpleMatch = res.data.match(/'(\/\/streamtape\.com\/get_video[^']+)'/);
        if (simpleMatch && simpleMatch[0]) {
            const videoSrc = 'https:' + simpleMatch[0].slice(1, -1); // remove quotes
            return [{ source: 'StreamTape', quality: 'Stream', url: videoSrc }];
        }

        // If we reach here, the link is likely dead or protected. Return nothing.
        return [];
    } catch (e) {
        // A 404 error just means the link is dead. We can ignore it and return nothing.
        if (!e.response || e.response.status !== 404) {
            console.error(`[StreamTape] An unexpected error occurred for ${normalizedLink}:`, e.message);
        }
        return []; // Return empty array on any failure
    }
}

async function hubStreamExtractor(url, referer) {
    // Hubstream extends VidStack in the Kotlin code, but for this JS version
    // we'll treat it as a generic extractor that might return direct links
    try {
        const response = await axios.get(url, { headers: { ...HEADERS, Referer: referer }, httpsAgent: agent });
        // For now, return the URL as-is since VidStack extraction is complex
        return [{ source: 'Hubstream', quality: 'Unknown', url }];
    } catch (e) {
        console.error(`[Hubstream] Failed to extract from ${url}:`, e.message);
        return [];
    }
}

async function hbLinksExtractor(url, referer) {
    const response = await axios.get(url, { headers: { ...HEADERS, Referer: referer }, httpsAgent: agent });
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
    const response = await axios.get(url, { headers: { ...HEADERS, Referer: referer }, httpsAgent: agent });
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
    const response = await axios.get(url, { headers: { ...HEADERS, Referer: referer }, httpsAgent: agent });
    const $ = cheerio.load(response.data);
    const href = $('.btn.btn-primary.btn-user.btn-success1.m-1').attr('href');
    if (href) {
        return loadExtractor(href, url);
    }
    return [];
}


async function hubCloudExtractor(url, referer) {
    let currentUrl = url;
    // Replicate domain change logic from HubCloud extractor
    if (currentUrl.includes("hubcloud.ink")) {
        currentUrl = currentUrl.replace("hubcloud.ink", "hubcloud.dad");
    }

    let pageResponse = await axios.get(currentUrl, { headers: { ...HEADERS, Referer: referer }, httpsAgent: agent });
    let finalUrl = currentUrl;

    if (!currentUrl.includes("hubcloud.php")) {
        const scriptUrlMatch = pageResponse.data.match(/var url = '([^']*)'/);
        if (scriptUrlMatch && scriptUrlMatch[1]) {
            finalUrl = scriptUrlMatch[1];
            pageResponse = await axios.get(finalUrl, { headers: { ...HEADERS, Referer: currentUrl }, httpsAgent: agent });
        }
    }

    const $ = cheerio.load(pageResponse.data);
    const size = $('i#size').text().trim();
    const header = $('div.card-header').text().trim();

    // Use the same quality detection logic as Kotlin code
    const getIndexQuality = (str) => {
        const match = (str || '').match(/(\d{3,4})[pP]/);
        return match ? parseInt(match[1]) : 2160; // Default to 4K if not found
    };

    const quality = getIndexQuality(header);
    const headerDetails = cleanTitle(header);

    // Build label extras like in Kotlin code
    const labelExtras = (() => {
        let extras = '';
        if (headerDetails) extras += `[${headerDetails}]`;
        if (size) extras += `[${size}]`;
        return extras;
    })();

    // Convert human-readable size to bytes for consistency
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
        const sourceName = text.trim();

        if (text.includes("Download File")) {
            links.push({ source: `HubCloud ${labelExtras}`, quality, url: link, size: sizeInBytes });
        } else if (text.includes("FSL Server")) {
            links.push({ source: `HubCloud - FSL Server ${labelExtras}`, quality, url: link, size: sizeInBytes });
        } else if (text.includes("S3 Server")) {
            links.push({ source: `HubCloud - S3 Server ${labelExtras}`, quality, url: link, size: sizeInBytes });
        } else if (text.includes("BuzzServer")) {
            try {
                const buzzResp = await axios.get(`${link}/download`, {
                    headers: { ...HEADERS, Referer: link },
                    maxRedirects: 0, // Do not follow redirects
                    validateStatus: status => status >= 200 && status < 400, // Accept 3xx codes
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
                    console.error("[HubCloud] BuzzServer redirect not found for", link);
                }
            }
        } else if (link.includes("pixeldra")) {
            links.push({ source: `Pixeldrain ${labelExtras}`, quality, url: link, size: sizeInBytes });
        } else if (text.includes("10Gbps")) {
            let currentRedirectUrl = link;
            let finalLink = null;
            for (let i = 0; i < 5; i++) { // Max 5 redirects
                try {
                    const response = await axios.get(currentRedirectUrl, { maxRedirects: 0, validateStatus: null, httpsAgent: agent });
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
                        console.error("[HubCloud] 10Gbps redirect failed for", currentRedirectUrl);
                        break;
                    }
                }
            }
            if (finalLink) {
                links.push({ source: `HubCloud - 10Gbps ${labelExtras}`, quality, url: finalLink, size: sizeInBytes });
            }
        } else {
            // For other buttons, try the generic extractor
            const extracted = await loadExtractor(link, finalUrl);
            links.push(...extracted);
        }
    }
    return links;
}

// =================================================================================
// MAIN PROVIDER LOGIC (from HDhub4uProvider.kt)
// =================================================================================

/**
 * Searches for media on HDHub4u.
 * @param {string} query The search term.
 * @returns {Promise<Array<{title: string, url: string, poster: string}>>} A list of search results.
 */
async function search(query) {
    const currentDomain = await getCurrentDomain();
    const searchUrl = `${currentDomain}/?s=${encodeURIComponent(query)}`;
    const response = await axios.get(searchUrl, { headers: HEADERS, httpsAgent: agent });
    const $ = cheerio.load(response.data);

    return $('.recent-movies > li.thumb').map((i, el) => {
        const element = $(el);
        return {
            title: element.find('figcaption:nth-child(2) > a:nth-child(1) > p:nth-child(1)').text().trim(),
            url: element.find('figure:nth-child(1) > a:nth-child(2)').attr('href'),
            poster: element.find('figure:nth-child(1) > img:nth-child(1)').attr('src'),
        };
    }).get();
}

/**
 * Fetches the media page and extracts all hoster links.
 * This combines the logic of `load()` and `loadLinks()` from the Kotlin provider.
 * @param {string} mediaUrl The URL of the movie or TV show page.
 * @returns {Promise<Array<any>>} A list of all final, extracted download links.
 */
/**
 * Fetches enhanced metadata from Cinemeta API using IMDB ID.
 * Replicates the Cinemeta integration from the Kotlin provider.
 */
async function getCinemetaData(imdbId, tvType) {
    if (!imdbId) return null;

    try {
        const cinemetaUrl = `https://v3-cinemeta.strem.io/meta/${tvType}/${imdbId}.json`;
        const response = await axios.get(cinemetaUrl, { httpsAgent: agent });
        return response.data;
    } catch (e) {
        console.error(`[Cinemeta] Failed to fetch metadata for ${imdbId}:`, e.message);
        return null;
    }
}

async function getDownloadLinks(mediaUrl) {
    const currentDomain = await getCurrentDomain();
    HEADERS.Referer = `${currentDomain}/`;
    const response = await axios.get(mediaUrl, { headers: HEADERS, httpsAgent: agent });
    const $ = cheerio.load(response.data);

    const typeRaw = $('h1.page-title span').text();
    const isMovie = typeRaw.toLowerCase().includes('movie');

    // Extract title and season number like in Kotlin code
    const title = $('.page-body h2[data-ved="2ahUKEwjL0NrBk4vnAhWlH7cAHRCeAlwQ3B0oATAfegQIFBAM"], h2[data-ved="2ahUKEwiP0pGdlermAhUFYVAKHV8tAmgQ3B0oATAZegQIDhAM"]').text();
    const seasonMatch = title.match(/\bSeason\s*(\d+)\b/i);
    const seasonNumber = seasonMatch ? parseInt(seasonMatch[1]) : null;

    let initialLinks = [];

    if (isMovie) {
        // Replicate the exact Kotlin selector: "h3 a:matches(480|720|1080|2160|4K), h4 a:matches(480|720|1080|2160|4K)"
        // Find anchor tags inside h3/h4 whose text contains quality numbers
        const qualityLinks = $('h3 a, h4 a').filter((i, el) => {
            const linkText = $(el).text();
            return linkText.match(/480|720|1080|2160|4K/i);
        });

        initialLinks = qualityLinks.map((i, el) => ({ url: $(el).attr('href') })).get();

        // Remove duplicates and invalid URLs
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

        // First, look for quality-specific redirect links (like 1080p techyboy4u.com links)
        $('h3 a, h4 a').each((i, element) => {
            const $el = $(element);
            const text = $el.text();
            const href = $el.attr('href');
            
            // Check if this is a quality link (1080p, 720p, etc.) that might lead to episode links
            if (text.match(/1080|720|4K|2160/i) && href && href.includes('techyboy4u.com')) {
                // This is likely a redirect to a page with episode links
                initialLinks.push({ url: href, isQualityRedirect: true });
            }
        });

        // Then, try to find episode links in h4 elements (common structure)
        $('h4').each((i, element) => {
            const $el = $(element);
            const text = $el.text();
            // Match both "EPiSODE 1" and "E01" formats
            const episodeMatch = text.match(/(?:EPiSODE\s*(\d+)|E(\d+))/i);
            
            if (episodeMatch) {
                const epNum = parseInt(episodeMatch[1] || episodeMatch[2]);
                if (!episodeLinksMap.has(epNum)) episodeLinksMap.set(epNum, []);
                
                // Get all links from this h4 element
                const links = $el.find('a').map((i, a) => $(a).attr('href')).get();
                episodeLinksMap.get(epNum).push(...links);
            }
        });

        // If no episodes found in h4, try the original logic with h3/h4
        if (episodeLinksMap.size === 0) {
            for (const element of $('h3, h4').get()) {
                const $el = $(element);
                const title = $el.text();
                // Match both "EPiSODE 1" and "E01" formats
                const episodeMatch = title.match(/(?:EPiSODE\s*(\d+)|E(\d+))/i);
                const epNum = episodeMatch ? parseInt(episodeMatch[1] || episodeMatch[2]) : null;

                const isDirectLinkBlock = $el.find('a').text().match(/1080|720|4K|2160/i);

                if (isDirectLinkBlock) {
                    const redirectLinks = $el.find('a').map((i, a) => $(a).attr('href')).get();
                    for (const redirectLink of redirectLinks) {
                        try {
                            const resolvedUrl = await getRedirectLinks(redirectLink);
                            const episodeDocPage = await axios.get(resolvedUrl, { headers: HEADERS, httpsAgent: agent });
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
                            console.error(`Error resolving direct link block: ${redirectLink}`, e.message);
                        }
                    }

                } else if (epNum) {
                    if (!episodeLinksMap.has(epNum)) episodeLinksMap.set(epNum, []);

                    // Get links from current h3/h4
                    const baseLinks = $el.find('a').map((i, a) => $(a).attr('href')).get();
                    episodeLinksMap.get(epNum).push(...baseLinks);

                    // Get links from sibling elements until the next <hr>
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
            // Flatten and unique links per episode
            const uniqueLinks = [...new Set(links)];
            initialLinks.push(...uniqueLinks.map(link => ({ url: link, episode: epNum })));
        });
    }

    console.log(`Found ${initialLinks.length} initial hoster links. Now extracting...`);

    const allFinalLinks = [];
    // Process all links in parallel
    const promises = initialLinks.map(async (linkInfo) => {
        try {
            // Handle quality redirect links (like techyboy4u.com)
            if (linkInfo.isQualityRedirect) {
                // Follow the redirect to get the actual episode page
                const resolvedUrl = await getRedirectLinks(linkInfo.url);
                const episodeDocPage = await axios.get(resolvedUrl, { headers: HEADERS, httpsAgent: agent });
                const $$ = cheerio.load(episodeDocPage.data);
                
                // Extract episode links from h5 elements
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
                
                // Also look for h3 links (pack downloads, etc.) but exclude zip files
                 $$('h3 a').each((i, linkEl) => {
                     const linkHref = $$(linkEl).attr('href');
                     const linkText = $$(linkEl).text();
                     if (linkHref && !linkHref.includes('magnet:') && !linkHref.includes('.zip') && !linkText.toLowerCase().includes('pack')) {
                         episodeLinks.push({ url: linkHref, episode: null }); // Individual downloads only
                     }
                 });
                
                // Process each episode link
                const episodePromises = episodeLinks.map(async (epLink) => {
                    try {
                        const extractedLinks = await loadExtractor(epLink.url, resolvedUrl);
                        return extractedLinks.map(finalLink => ({ ...finalLink, episode: epLink.episode }));
                    } catch (e) {
                        console.error(`Failed to extract episode link ${epLink.url}:`, e.message);
                        return [];
                    }
                });
                
                const episodeResults = await Promise.all(episodePromises);
                return episodeResults.flat();
            } else {
                // Handle regular links
                const extractedLinks = await loadExtractor(linkInfo.url, mediaUrl);
                return extractedLinks.map(finalLink => ({ ...finalLink, episode: linkInfo.episode }));
            }
        } catch (e) {
            console.error(`Failed to extract from ${linkInfo.url}:`, e.message);
            return [];
        }
    });

    const results = await Promise.all(promises);
    results.forEach(res => allFinalLinks.push(...res));

    // Remove exact duplicate URLs and zip files
    const seenUrls = new Set();
    const uniqueFinalLinks = allFinalLinks.filter(link => {
        // Filter out zip files
        if (link.url && (link.url.includes('.zip') || (link.name && link.name.toLowerCase().includes('.zip')))) {
            return false;
        }
        // Filter out duplicates
        if (seenUrls.has(link.url)) {
            return false;
        }
        seenUrls.add(link.url);
        return true;
    });

    return { finalLinks: uniqueFinalLinks, isMovie };
}

// =================================================================================
// DISPLAY FUNCTION & EXAMPLE USAGE
// =================================================================================

/**
 * Filters, sorts, and displays the extracted links.
 * It only shows links from sources explicitly supported by the original plugin.
 * @param {Array<any>} links The array of extracted link objects.
 * @param {boolean} isTvSeries A boolean to indicate if the media is a TV series.
 */
function filterAndDisplayLinks(links, isTvSeries, selectedEpisode = null) {
    const supportedSources = [
        'HubCloud', 'HubCdn', 'HubDrive', 'Hblinks', 'Hubstream',
        'HdStream4u', 'StreamTape', 'Pixeldrain',
    ];

    let supportedLinks = links.filter(link =>
        supportedSources.some(source => (link.source || '').startsWith(source))
    );
    
    // Filter by selected episode if specified
    if (isTvSeries && selectedEpisode !== null) {
        supportedLinks = supportedLinks.filter(link => link.episode === selectedEpisode);
        if (supportedLinks.length === 0) {
            console.log(`\nNo links found for Episode ${selectedEpisode} from supported sources.`);
            return;
        }
    }

    if (supportedLinks.length === 0) {
        console.log("\nNo links found from supported sources.");
        return;
    }

    // --- Start of Deduplication Logic ---

    // Remove exact duplicate URLs
    const seenUrls = new Set();
    const uniqueLinks = [];
    
    // Define a preference order for sources to determine which duplicate to keep
    const sourcePreference = [
        /HubCloud - Download File/,
        /HubCloud - FSL Server/,
        /HubCloud - S3 Server/,
        /Pixeldrain/,
        /HubCloud - 10Gbps/,
        /HubCloud - BuzzServer/,
        /StreamTape/,
    ];
    
    // Sort all links by source preference first
    supportedLinks.sort((a, b) => {
        const aIndex = sourcePreference.findIndex(re => re.test(a.source));
        const bIndex = sourcePreference.findIndex(re => re.test(b.source));
        
        const effectiveAIndex = aIndex === -1 ? Infinity : aIndex;
        const effectiveBIndex = bIndex === -1 ? Infinity : bIndex;
        
        return effectiveAIndex - effectiveBIndex;
    });
    
    // Keep only the first occurrence of each URL (which will be the highest priority source)
    supportedLinks.forEach(link => {
        if (!seenUrls.has(link.url)) {
            seenUrls.add(link.url);
            uniqueLinks.push(link);
        }
    });

    const finalLinkList = uniqueLinks;
    // --- End of Deduplication Logic ---


    // Helper to convert bytes to a human-readable format
    const formatBytes = (bytes, decimals = 2) => {
        if (!+bytes) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
    };

    // Helper to convert quality string to a numeric value for sorting.
    const getQualityValue = (quality) => {
        if (typeof quality !== 'string') return 0;
        const match = quality.match(/(\d+)/);
        return match ? parseInt(match[0], 10) : 0;
    };

    // Sort the links
    finalLinkList.sort((a, b) => {
        // 1. Sort by episode number if it exists
        if (isTvSeries && a.episode !== b.episode) {
            return (a.episode || 0) - (b.episode || 0);
        }

        // 2. Sort by quality (descending)
        const qualityA = getQualityValue(a.quality);
        const qualityB = getQualityValue(b.quality);
        if (qualityA !== qualityB) {
            return qualityB - qualityA;
        }

        // 3. Sort by source preference (already handled in deduplication)

        // 4. Sort by source name (ascending, this will be secondary)
        const sourceRankA = sourcePreference.findIndex(re => re.test(a.source));
        const sourceRankB = sourcePreference.findIndex(re => re.test(b.source));
        const effectiveRankA = sourceRankA === -1 ? Infinity : sourceRankA;
        const effectiveRankB = sourceRankB === -1 ? Infinity : sourceRankB;

        if (effectiveRankA !== effectiveRankB) {
            return effectiveRankA - effectiveRankB;
        }

        // 5. Finally sort by original source name string if ranks are equal
        return (a.source || '').localeCompare(b.source || '');
    });

    const episodeText = (isTvSeries && selectedEpisode !== null) ? ` for Episode ${selectedEpisode}` : '';
    console.log(`\nSuccessfully extracted ${finalLinkList.length} final links from supported sources${episodeText}:`);

    if (isTvSeries && selectedEpisode === null) {
        // Show all episodes grouped
        const linksByEpisode = finalLinkList.reduce((acc, link) => {
            const ep = link.episode || 'Unknown Episode';
            if (!acc[ep]) {
                acc[ep] = [];
            }
            acc[ep].push(link);
            return acc;
        }, {});

        for (const episode in linksByEpisode) {
            console.log(`\n--- Episode ${episode} ---`);
            linksByEpisode[episode].forEach(link => {
                const sizePart = link.size ? `[${formatBytes(link.size)}] ` : '';
                const namePart = link.name ? `- ${link.name} ` : '';
                // The source name from hubcloud might already contain the size, so we clean it
                const sourceClean = link.source.replace(/\[.*(GB|MB|KB)\]/i, '').trim();
                console.log(`  [${String(link.quality).padEnd(7)}] [${sourceClean}] ${sizePart}${namePart}- ${link.url}`);
            });
        }
    } else {
        // Show all links for movie or specific episode
        finalLinkList.forEach(link => {
            const sizePart = link.size ? `[${formatBytes(link.size)}] ` : '';
            const namePart = link.name ? `- ${link.name} ` : '';
            // The source name from hubcloud might already contain the size, so we clean it
            const sourceClean = link.source.replace(/\[.*(GB|MB|KB)\]/i, '').trim();
            console.log(`  [${String(link.quality).padEnd(7)}] [${sourceClean}] ${sizePart}${namePart}- ${link.url}`);
        });
    }
}


// Create readline interface for user input
function createReadlineInterface() {
    return readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
}

// Helper function to get user input
function getUserInput(question) {
    const rl = createReadlineInterface();
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

// Helper function to get numeric input with validation
async function getNumericInput(question, min = 1, max = null) {
    while (true) {
        const input = await getUserInput(question);
        const num = parseInt(input);
        
        if (isNaN(num) || num < min || (max && num > max)) {
            console.log(`Please enter a valid number${max ? ` between ${min} and ${max}` : ` >= ${min}`}.`);
            continue;
        }
        
        return num;
    }
}

async function main() {
    console.log("HDHub4u Scraper started...");

    // 0. Fetch the latest domain before doing anything else.
    await fetchAndUpdateDomain();

    // 1. GET USER INPUT FOR MEDIA TYPE AND DETAILS
    const showName = await getUserInput("Enter the name of the movie or TV show: ");
    
    if (!showName) {
        console.log("No show name provided. Exiting.");
        return;
    }

    // 2. ASK IF IT'S A TV SHOW OR MOVIE
    const mediaType = await getUserInput("Is this a TV show or movie? (tv/movie): ");
    const isTvShow = mediaType.toLowerCase().startsWith('tv') || mediaType.toLowerCase().startsWith('show') || mediaType.toLowerCase().startsWith('series');
    
    let searchQuery = showName;
    let targetSeason = null;
    let targetEpisode = null;
    
    if (isTvShow) {
        // 3. GET SEASON AND EPISODE FOR TV SHOWS
        targetSeason = await getNumericInput("Enter season number: ", 1);
        
        const wantSpecificEpisode = await getUserInput("Do you want a specific episode or all episodes? (specific/all): ");
        
        if (wantSpecificEpisode.toLowerCase().startsWith('s') || wantSpecificEpisode.toLowerCase().startsWith('specific') || !isNaN(parseInt(wantSpecificEpisode))) {
            // If user entered a number directly, use it as episode number
            const directEpisodeNum = parseInt(wantSpecificEpisode);
            if (!isNaN(directEpisodeNum) && directEpisodeNum > 0) {
                targetEpisode = directEpisodeNum;
            } else {
                targetEpisode = await getNumericInput("Enter episode number: ", 1);
            }
        }
        
        // Construct more specific search query
        searchQuery = `${showName} season ${targetSeason}`;
        console.log(`\nSearching for "${searchQuery}"...`);
    } else {
        console.log(`\nSearching for movie "${searchQuery}"...`);
    }

    const searchResults = await search(searchQuery);

    if (searchResults.length === 0) {
        console.log("No results found.");
        if (isTvShow) {
            console.log(`Try searching for just "${showName}" or check if the season number is correct.`);
        }
        return;
    }

    console.log(`\nFound ${searchResults.length} results from the site:`);
    searchResults.forEach((r, index) => {
        console.log(`  ${index + 1}. ${r.title}`);
    });

    // 4. Automatically select the best match based on search criteria
    let mediaToProcess;
    
    if (searchResults.length === 1) {
        mediaToProcess = searchResults[0];
        console.log(`\n--> Automatically selected: "${mediaToProcess.title}"`);
    } else {
        // Find best match based on search query
        const lowerSearchQuery = searchQuery.toLowerCase();
        const bestMatch = searchResults.find(r => {
            const title = r.title.toLowerCase();
            if (isTvShow && targetSeason) {
                // For TV shows, prioritize exact season match
                return title.includes(showName.toLowerCase()) && 
                       (title.includes(`season ${targetSeason}`) || title.includes(`s${targetSeason}`));
            } else {
                // For movies or general search, find closest title match
                return title.includes(showName.toLowerCase());
            }
        });
        
        if (bestMatch) {
            mediaToProcess = bestMatch;
            console.log(`\n--> Automatically selected best match: "${mediaToProcess.title}"`);
        } else {
            // Fallback to first result if no perfect match
            mediaToProcess = searchResults[0];
            console.log(`\n--> No exact match found, using first result: "${mediaToProcess.title}"`);
        }
    }

    // 5. GET DOWNLOAD LINKS
    console.log(`\nGetting download links for: ${mediaToProcess.title}`);
    console.log(`URL: ${mediaToProcess.url}`);

    const { finalLinks, isMovie } = await getDownloadLinks(mediaToProcess.url);

    // 6. FILTER AND DISPLAY RESULTS BASED ON USER'S INITIAL CHOICE
    if (isTvShow && targetEpisode) {
        // User wants a specific episode - filter immediately
        const episodeLinks = finalLinks.filter(link => link.episode === targetEpisode);
        if (episodeLinks.length === 0) {
            console.log(`\nNo links found for Episode ${targetEpisode}.`);
            const availableEpisodes = [...new Set(finalLinks.map(link => link.episode).filter(ep => ep))];
            if (availableEpisodes.length > 0) {
                console.log(`Available episodes: ${availableEpisodes.sort((a, b) => a - b).join(', ')}`);
                console.log(`\nTip: Try running the script again with one of the available episode numbers.`);
            } else {
                console.log(`No episode information found. This might be a movie or the page structure is different.`);
            }
        } else {
            console.log(`\nFound ${episodeLinks.length} links for Episode ${targetEpisode}:`);
            filterAndDisplayLinks(episodeLinks, false, null); // Display as single episode, not grouped
        }
    } else if (isTvShow) {
        // Show all episodes for TV shows
        console.log(`\nShowing all available episodes:`);
        filterAndDisplayLinks(finalLinks, true, null);
    } else {
        // Show all links for movies
        filterAndDisplayLinks(finalLinks, false, null);
    }
}

main().catch(err => {
    console.error("\nAn unexpected error occurred:", err);
});