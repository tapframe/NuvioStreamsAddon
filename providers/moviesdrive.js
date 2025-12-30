/**
 * MoviesDrive streaming provider integration for Stremio
 * Standalone version with integrated extraction logic
 */

const axios = require('axios');
const https = require('https');
const http = require('http');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const path = require('path');
const RedisCache = require('../utils/redisCache');

// Using Cheerio for HTML parsing (more memory efficient than JSDOM)

// Cache configuration
const CACHE_ENABLED = process.env.DISABLE_CACHE !== 'true';
console.log(`[MoviesDrive] Internal cache is ${CACHE_ENABLED ? 'enabled' : 'disabled'}.`);
const CACHE_DIR = process.env.VERCEL ? path.join('/tmp', '.moviesdrive_cache') : path.join(__dirname, '.cache', 'moviesdrive');

// Initialize Redis cache
const redisCache = new RedisCache('MoviesDrive');

// Main URL for MoviesDrive
let mainUrl = 'https://moviesdrive.design';

// Cache helper functions
const ensureCacheDir = async () => {
    if (!CACHE_ENABLED) return;

    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
    } catch (error) {
        console.error(`[MoviesDrive] Error creating cache directory: ${error.message}`);
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

// Initialize cache directory
ensureCacheDir();

// Function to make HTTP requests without async/await
function makeRequest(url, callback, allowRedirects = true) {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;

    const options = {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
    };

    const req = protocol.request(options, (res) => {
        // Handle redirects
        if (allowRedirects && (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308)) {
            const redirectUrl = res.headers.location;
            if (redirectUrl) {
                const fullRedirectUrl = redirectUrl.startsWith('http') ? redirectUrl : new URL(redirectUrl, url).href;
                makeRequest(fullRedirectUrl, callback, allowRedirects);
                return;
            }
        }

        let data = '';
        res.on('data', (chunk) => {
            data += chunk;
        });
        res.on('end', () => {
            callback(null, data, res);
        });
    });

    req.on('error', (err) => {
        callback(err, null, null);
    });

    req.end();
}

// Function to get base URL from GitHub
function getBaseUrl(callback) {
    makeRequest('https://raw.githubusercontent.com/SaurabhKaperwan/Utils/refs/heads/main/urls.json', (err, data) => {
        if (err) {
            console.log('Using default URL');
            callback(mainUrl);
            return;
        }
        try {
            const json = JSON.parse(data);
            const newUrl = json.moviesdrive;
            if (newUrl) {
                mainUrl = newUrl;
                console.log('Updated base URL to:', mainUrl);
            }
            callback(mainUrl);
        } catch (e) {
            console.log('Error parsing URLs JSON, using default');
            callback(mainUrl);
        }
    });
}

// Function to search for movies/shows with caching
async function searchContent(query, callback) {
    const cacheKey = `search_${query.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

    try {
        // Check cache first
        let cachedResults = await getFromCache(cacheKey);
        if (cachedResults && cachedResults.length > 0) {
            console.log(`[MoviesDrive] Cache HIT for search: ${query}. Using ${cachedResults.length} cached results.`);
            callback(cachedResults);
            return;
        }

        if (cachedResults && cachedResults.length === 0) {
            console.log(`[MoviesDrive] Cache contains empty data for search: ${query}. Refetching from source.`);
        } else {
            console.log(`[MoviesDrive] Cache MISS for search: ${query}. Fetching from source.`);
        }

        const searchResults = [];
        let pagesChecked = 0;
        const maxPages = 7;

        function searchPage(page) {
            const searchUrl = `${mainUrl}/page/${page}/?s=${encodeURIComponent(query)}`;

            makeRequest(searchUrl, (err, html) => {
                if (err) {
                    console.error(`Error searching page ${page}:`, err.message);
                    pagesChecked++;
                    if (pagesChecked === maxPages) {
                        // Cache empty result to avoid repeated failed requests
                        saveToCache(cacheKey, searchResults);
                        callback(searchResults);
                    }
                    return;
                }

                const $ = cheerio.load(html);
                const movieElements = $('ul.recent-movies > li');

                if (movieElements.length === 0) {
                    // Cache the results (even if empty)
                    saveToCache(cacheKey, searchResults);
                    callback(searchResults);
                    return;
                }

                movieElements.each((index, element) => {
                    const $element = $(element);
                    const titleElement = $element.find('figure > img');
                    const linkElement = $element.find('figure > a');
                    const posterElement = $element.find('figure > img');

                    if (titleElement.length && linkElement.length) {
                        const title = titleElement.attr('title');
                        const href = linkElement.attr('href');
                        const posterUrl = posterElement.attr('src') || '';

                        if (title && href) {
                            searchResults.push({
                                title: title.replace('Download ', ''),
                                url: href,
                                poster: posterUrl || ''
                            });
                        }
                    }
                });

                pagesChecked++;
                if (pagesChecked < maxPages && movieElements.length > 0) {
                    searchPage(page + 1);
                } else {
                    // Cache the final results
                    console.log(`[MoviesDrive] Caching ${searchResults.length} search results for: ${query}`);
                    saveToCache(cacheKey, searchResults);
                    callback(searchResults);
                }
            });
        }

        searchPage(1);
    } catch (error) {
        console.error(`[MoviesDrive] Error in searchContent:`, error.message);
        callback([]);
    }
}

// Function to extract quality from filename
function extractQuality(str) {
    if (!str) return 'Unknown';
    const match = str.match(/(\d{3,4})[pP]/);
    return match ? match[1] + 'p' : 'Unknown';
}

// Function to extract quality from filename and return numeric value for sorting
function getIndexQuality(str) {
    if (!str) return 0;
    const match = str.match(/(\d{3,4})[pP]/);
    return match ? parseInt(match[1]) : 0;
}

// Function to extract final streaming URLs from HubCloud
function extractHubCloudLinks(url, title, callback) {
    // Normalize to hubcloud.one
    const newUrl = url.replace(/https:\/\/hubcloud\.[^/]+/, 'https://hubcloud.one');

    makeRequest(newUrl, (err, html) => {
        if (err) {
            console.error('Error fetching HubCloud page:', err.message);
            callback([]);
            return;
        }

        const $ = cheerio.load(html);

        let link = '';
        if (newUrl.includes('drive')) {
            // Extract from script tag
            const scriptTags = $('script');
            let found = false;
            scriptTags.each((index, script) => {
                if (found) return false;
                const scriptContent = $(script).html() || '';
                const match = scriptContent.match(/var url = '([^']*)'/);
                if (match) {
                    link = match[1];
                    found = true;
                    return false;
                }
            });
        } else {
            // Extract from div.vd > center > a
            const linkElement = $('div.vd > center > a');
            if (linkElement.length) {
                link = linkElement.attr('href') || '';
            }
        }

        if (!link.startsWith('https://')) {
            link = 'https://hubcloud.one' + link;
        }

        if (!link) {
            callback([]);
            return;
        }

        // Get the final download page
        makeRequest(link, (err2, finalHtml) => {
            if (err2) {
                console.error('Error fetching HubCloud final page:', err2.message);
                callback([]);
                return;
            }

            const final$ = cheerio.load(finalHtml);

            const header = final$('div.card-header');
            const headerText = header.length ? header.text() : '';
            const sizeElement = final$('i#size');
            const size = sizeElement.length ? sizeElement.text() : '';

            const downloadButtons = final$('div.card-body h2 a.btn');
            const finalLinks = [];
            let processedButtons = 0;
            const totalButtons = downloadButtons.length;

            if (totalButtons === 0) {
                callback([]);
                return;
            }

            downloadButtons.each((index, button) => {
                const $button = final$(button);
                const buttonHref = $button.attr('href');
                const buttonText = $button.text() || '';

                const processButton = (finalUrl, sourceName) => {
                    if (finalUrl) {
                        finalLinks.push({
                            url: finalUrl,
                            source: sourceName || 'HubCloud',
                            title: title,
                            quality: extractQuality(headerText),
                            size: size,
                            fileName: headerText.trim()
                        });
                    }
                    processedButtons++;
                    if (processedButtons === totalButtons) {
                        callback(finalLinks);
                    }
                };

                if (buttonText.includes('Download [FSL Server]')) {
                    processButton(buttonHref, 'HubCloud[FSL Server]');
                } else if (buttonText.includes('Download File')) {
                    processButton(buttonHref, 'HubCloud');
                } else if (buttonText.includes('BuzzServer')) {
                    // Follow redirect for BuzzServer
                    const downloadUrl = buttonHref + '/download';
                    makeRequest(downloadUrl, (err, html, response) => {
                        if (response && response.headers && response.headers['hx-redirect']) {
                            const baseUrl = new URL(buttonHref).origin;
                            const redirectPath = response.headers['hx-redirect'];
                            processButton(baseUrl + redirectPath, 'HubCloud[BuzzServer]');
                        } else {
                            processButton(buttonHref, 'HubCloud[BuzzServer]');
                        }
                    }, false);
                } else if (buttonHref.includes('pixeldra')) {
                    // Convert Pixeldrain URL to API format
                    // Handles: pixeldrain.net/u/ID, pixeldrain.dev/u/ID, pixeldrain.com/u/ID
                    let finalPixeldrainUrl = buttonHref;
                    if (buttonHref && buttonHref.includes('/u/')) {
                        const fileId = buttonHref.split('/u/')[1].split('?')[0]; // Remove any query params
                        finalPixeldrainUrl = `https://pixeldrain.dev/api/file/${fileId}?download`;
                    }
                    processButton(finalPixeldrainUrl, 'Pixeldrain');
                } else if (buttonText.includes('Download [Server : 10Gbps]')) {
                    // Skip HubCloud [Download] links
                    processedButtons++;
                    if (processedButtons === totalButtons) {
                        callback(finalLinks);
                    }
                } else {
                    // Skip unknown button types
                    processedButtons++;
                    if (processedButtons === totalButtons) {
                        callback(finalLinks);
                    }
                }
            });
        });
    });
}

// Function to extract final streaming URLs from GDFlix
function extractGDFlixLinks(url, title, callback) {
    // Get latest GDFlix URL
    makeRequest('https://raw.githubusercontent.com/SaurabhKaperwan/Utils/refs/heads/main/urls.json', (err, urlData) => {
        let latestUrl = 'https://new10.gdflix.dad';
        if (!err && urlData) {
            try {
                const urlJson = JSON.parse(urlData);
                if (urlJson.gdflix) {
                    latestUrl = urlJson.gdflix;
                }
            } catch (e) {
                // Use default URL
            }
        }

        const newUrl = url.replace(/https:\/\/[^.]+\.gdflix\.[^/]+/, latestUrl).replace(/https:\/\/gdlink\.[^/]+/, latestUrl);

        makeRequest(newUrl, (err2, html) => {
            if (err2) {
                console.error('Error fetching GDFlix page:', err2.message);
                callback([]);
                return;
            }

            const $ = cheerio.load(html);

            const fileNameElement = $('ul > li.list-group-item');
            let fileName = '';
            let fileSize = '';

            const listItems = $('ul > li.list-group-item');
            listItems.each((index, item) => {
                const text = $(item).text() || '';
                if (text.includes('Name :')) {
                    fileName = text.replace('Name :', '').trim();
                } else if (text.includes('Size :')) {
                    fileSize = text.replace('Size :', '').trim();
                }
            });

            const downloadButtons = $('div.text-center a');
            const finalLinks = [];
            let processedButtons = 0;
            const totalButtons = downloadButtons.length;

            if (totalButtons === 0) {
                callback([]);
                return;
            }

            const processButton = (finalUrl, sourceName) => {
                if (finalUrl) {
                    finalLinks.push({
                        url: finalUrl,
                        source: sourceName || 'GDFlix',
                        title: title,
                        quality: extractQuality(fileName),
                        size: fileSize,
                        fileName: fileName
                    });
                }
                processedButtons++;
                if (processedButtons === totalButtons) {
                    callback(finalLinks);
                }
            };

            downloadButtons.each((index, button) => {
                const $button = $(button);
                const buttonHref = $button.attr('href');
                const buttonText = $button.text() || '';

                if (buttonText.includes('DIRECT DL')) {
                    processButton(buttonHref, 'GDFlix[Direct]');
                } else if (buttonText.includes('CLOUD DOWNLOAD [R2]')) {
                    processButton(buttonHref, 'GDFlix[Cloud Download]');
                } else if (buttonText.includes('PixelDrain DL')) {
                    // Convert Pixeldrain URL to API format
                    let finalPixeldrainUrl = buttonHref;
                    if (buttonHref && buttonHref.includes('/u/')) {
                        const fileId = buttonHref.split('/u/')[1].split('?')[0];
                        finalPixeldrainUrl = `https://pixeldrain.dev/api/file/${fileId}?download`;
                    }
                    processButton(finalPixeldrainUrl, 'Pixeldrain');
                } else if (buttonText.includes('Instant DL')) {
                    // Handle Instant DL - follow redirect
                    makeRequest(buttonHref, (err, html, response) => {
                        if (response && response.headers && response.headers.location) {
                            const location = response.headers.location;
                            const finalUrl = location.includes('url=') ?
                                location.substring(location.indexOf('url=') + 4) : location;
                            processButton(finalUrl, 'GDFlix[Instant Download]');
                        } else {
                            processButton(buttonHref, 'GDFlix[Instant Download]');
                        }
                    }, false);
                } else {
                    // Skip unknown button types
                    processedButtons++;
                    if (processedButtons === totalButtons) {
                        callback(finalLinks);
                    }
                }
            });
        });
    });
}

// Function to detect if query is for a specific episode
function detectEpisodePattern(query) {
    const episodePatterns = [
        /S(\d{1,2})E(\d{1,2})/i,  // S01E01
        /Season\s*(\d{1,2})\s*Episode\s*(\d{1,2})/i,  // Season 1 Episode 1
        /(\d{1,2})x(\d{1,2})/i   // 1x01
    ];

    for (let pattern of episodePatterns) {
        const match = query.match(pattern);
        if (match) {
            return {
                isEpisode: true,
                season: parseInt(match[1]),
                episode: parseInt(match[2]),
                pattern: pattern
            };
        }
    }

    return { isEpisode: false };
}

// Function to check if a filename matches the episode pattern
function matchesEpisode(filename, episodeInfo) {
    if (!episodeInfo.isEpisode) return true;

    const season = episodeInfo.season.toString().padStart(2, '0');
    const episode = episodeInfo.episode.toString().padStart(2, '0');

    const patterns = [
        new RegExp(`S${season}E${episode}`, 'i'),
        new RegExp(`S${episodeInfo.season}E${episodeInfo.episode}`, 'i'),
        new RegExp(`S${season}\.E${episode}`, 'i'),  // Handle S04.E02 format
        new RegExp(`S${episodeInfo.season}\.E${episodeInfo.episode}`, 'i'),  // Handle S4.E2 format
        new RegExp(`Season\\s*${episodeInfo.season}.*Episode\\s*${episodeInfo.episode}`, 'i'),
        new RegExp(`${episodeInfo.season}x${episode}`, 'i')
    ];

    return patterns.some(pattern => pattern.test(filename));
}

// Function to get server priority for sorting
function getServerPriority(source) {
    const priorities = {
        'HubCloud': 1,
        'GDFlix': 2,
        'Pixeldrain': 3,
        'GDLink': 4,
        'Unknown': 5
    };
    return priorities[source] || 5;
}

// Function to sort streaming links by quality (highest first) and server priority
function sortStreamingLinks(links) {
    return links.sort((a, b) => {
        // First sort by quality (highest first)
        const qualityA = getIndexQuality(a.quality || a.fileName || a.title);
        const qualityB = getIndexQuality(b.quality || b.fileName || b.title);

        if (qualityA !== qualityB) {
            return qualityB - qualityA; // Higher quality first
        }

        // If quality is same, sort by server priority
        const priorityA = getServerPriority(a.source);
        const priorityB = getServerPriority(b.source);

        return priorityA - priorityB; // Lower priority number = higher priority
    });
}

// Function to calculate similarity score between query and title
function calculateTitleSimilarity(query, title) {
    const normalizeText = (text) => {
        return text.toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    };

    const queryNorm = normalizeText(query);
    const titleNorm = normalizeText(title);

    // Exact match gets highest score
    if (queryNorm === titleNorm) return 100;

    // Check if query is contained in title
    if (titleNorm.includes(queryNorm)) return 90;

    // Check if title is contained in query
    if (queryNorm.includes(titleNorm)) return 85;

    // Word-based matching
    const queryWords = queryNorm.split(' ').filter(w => w.length > 2);
    const titleWords = titleNorm.split(' ').filter(w => w.length > 2);

    if (queryWords.length === 0 || titleWords.length === 0) return 0;

    let matchedWords = 0;
    let partialMatches = 0;

    queryWords.forEach(qWord => {
        const exactMatch = titleWords.some(tWord => tWord === qWord);
        if (exactMatch) {
            matchedWords++;
        } else {
            const partialMatch = titleWords.some(tWord =>
                tWord.includes(qWord) || qWord.includes(tWord)
            );
            if (partialMatch) partialMatches++;
        }
    });

    const exactScore = (matchedWords / queryWords.length) * 70;
    const partialScore = (partialMatches / queryWords.length) * 30;

    return exactScore + partialScore;
}

// Function to find best matching result
function findBestMatch(query, searchResults) {
    if (searchResults.length === 0) return null;
    if (searchResults.length === 1) return searchResults[0];

    const scoredResults = searchResults.map(result => ({
        ...result,
        score: calculateTitleSimilarity(query, result.title)
    }));

    // Sort by score (highest first)
    scoredResults.sort((a, b) => b.score - a.score);

    // Log top matches for debugging
    console.log('Top search matches:');
    scoredResults.slice(0, 3).forEach((result, index) => {
        console.log(`${index + 1}. ${result.title} (Score: ${result.score.toFixed(1)})`);
    });

    return scoredResults[0];
}

// Process cached download links to extract fresh streaming links
function processDownloadLinks(downloadLinks, callback, episodeInfo = null) {
    const allStreamingLinks = [];
    let processedPages = 0;

    downloadLinks.forEach(downloadLink => {
        makeRequest(downloadLink, (err, pageHtml) => {
            if (err) {
                console.error('Error fetching download page:', err.message);
                processedPages++;
                if (processedPages === downloadLinks.length) {
                    callback(allStreamingLinks);
                }
                return;
            }

            const page$ = cheerio.load(pageHtml);

            // Look for streaming links (HubCloud, GDFlix, GDLink)
            const streamingElements = page$('a');
            const intermediateLinks = [];

            streamingElements.each((index, element) => {
                const $element = page$(element);
                const href = $element.attr('href') || '';
                const text = $element.text() || '';

                if (href && (href.toLowerCase().includes('hubcloud') ||
                    href.toLowerCase().includes('gdflix') ||
                    href.toLowerCase().includes('gdlink'))) {

                    let source = 'Unknown';
                    if (text.toLowerCase().includes('hubcloud') || href.toLowerCase().includes('hubcloud')) {
                        source = 'HubCloud';
                    } else if (text.toLowerCase().includes('gdflix') || href.toLowerCase().includes('gdflix')) {
                        source = 'GDFlix';
                    } else if (text.toLowerCase().includes('gdlink') || href.toLowerCase().includes('gdlink')) {
                        source = 'GDLink';
                    }

                    intermediateLinks.push({
                        url: href,
                        source: source
                    });
                }
            });

            // Now extract final URLs from each intermediate link
            let extractedCount = 0;
            const totalToExtract = intermediateLinks.length;

            if (totalToExtract === 0) {
                processedPages++;
                if (processedPages === downloadLinks.length) {
                    callback(allStreamingLinks);
                }
                return;
            }

            intermediateLinks.forEach(intermediate => {
                if (intermediate.source === 'HubCloud') {
                    extractHubCloudLinks(intermediate.url, '', (hubCloudLinks) => {
                        // Filter for specific episode if requested
                        let filteredLinks = hubCloudLinks;
                        if (episodeInfo && episodeInfo.isEpisode) {
                            filteredLinks = hubCloudLinks.filter(link => {
                                return matchesEpisode(link.fileName || link.title || '', episodeInfo);
                            });
                        }
                        allStreamingLinks.push(...filteredLinks);
                        extractedCount++;

                        if (extractedCount === totalToExtract) {
                            processedPages++;
                            if (processedPages === downloadLinks.length) {
                                callback(allStreamingLinks);
                            }
                        }
                    });
                } else if (intermediate.source === 'GDFlix' || intermediate.source === 'GDLink') {
                    extractGDFlixLinks(intermediate.url, '', (gdFlixLinks) => {
                        // Filter for specific episode if requested
                        let filteredLinks = gdFlixLinks;
                        if (episodeInfo && episodeInfo.isEpisode) {
                            filteredLinks = gdFlixLinks.filter(link => {
                                return matchesEpisode(link.fileName || link.title || '', episodeInfo);
                            });
                        }
                        allStreamingLinks.push(...filteredLinks);
                        extractedCount++;

                        if (extractedCount === totalToExtract) {
                            processedPages++;
                            if (processedPages === downloadLinks.length) {
                                callback(allStreamingLinks);
                            }
                        }
                    });
                } else {
                    extractedCount++;
                    if (extractedCount === totalToExtract) {
                        processedPages++;
                        if (processedPages === downloadLinks.length) {
                            callback(allStreamingLinks);
                        }
                    }
                }
            });
        });
    });
}

// Function to extract streaming links from a movie/show page
async function extractStreamingLinks(url, callback, episodeInfo = null) {
    const episodeKey = episodeInfo && episodeInfo.isEpisode ? `_S${episodeInfo.season}E${episodeInfo.episode}` : '';
    const cacheKey = `download_links_${url.replace(/[^a-z0-9]/gi, '_')}${episodeKey}`;

    try {
        // Check cache for intermediate download links (not final streaming links)
        let cachedDownloadLinks = await getFromCache(cacheKey);
        if (cachedDownloadLinks && cachedDownloadLinks.length > 0) {
            console.log(`[MoviesDrive] Cache HIT for download links: ${url}. Using ${cachedDownloadLinks.length} cached download links.`);
            // Process cached download links to get fresh streaming links
            processDownloadLinks(cachedDownloadLinks, callback, episodeInfo);
            return;
        }

        if (cachedDownloadLinks && cachedDownloadLinks.length === 0) {
            console.log(`[MoviesDrive] Cache contains empty data for download links: ${url}. Refetching from source.`);
        } else {
            console.log(`[MoviesDrive] Cache MISS for download links: ${url}. Fetching from source.`);
        }

        makeRequest(url, (err, html) => {
            if (err) {
                console.error('Error fetching movie page:', err.message);
                // Cache empty result to avoid repeated failed requests
                saveToCache(cacheKey, []);
                callback([]);
                return;
            }

            const $ = cheerio.load(html);

            // Get download buttons
            const buttons = $('h5 > a');
            let downloadLinks = [];

            buttons.each((index, button) => {
                const $button = $(button);
                const buttonText = $button.text() || '';
                if (!buttonText.toLowerCase().includes('zip')) {
                    const href = $button.attr('href');
                    if (href) {
                        downloadLinks.push(href);
                    }
                }
            });

            if (downloadLinks.length === 0) {
                // Cache empty result
                saveToCache(cacheKey, []);
                callback([]);
                return;
            }

            // Cache the download links (intermediate data, not final streaming links)
            console.log(`[MoviesDrive] Caching ${downloadLinks.length} download links for: ${url}`);
            saveToCache(cacheKey, downloadLinks);

            // Process download links to get fresh streaming links
            processDownloadLinks(downloadLinks, callback, episodeInfo);
        });
    } catch (error) {
        console.error(`[MoviesDrive] Error in extractStreamingLinks:`, error.message);
        callback([]);
    }
}

// Main function to search and extract links
function findStreamingLinks(query, callback) {
    // Detect if query is for a specific episode
    const episodeInfo = detectEpisodePattern(query);

    // If searching for a specific episode, extract the series name for search
    let searchQuery = query;
    if (episodeInfo.isEpisode) {
        // Remove episode patterns from the search query
        searchQuery = query.replace(/S\d{1,2}E\d{1,2}/i, '')
            .replace(/Season\s*\d{1,2}\s*Episode\s*\d{1,2}/i, '')
            .replace(/\d{1,2}x\d{1,2}/i, '')
            .trim();
        console.log(`Searching for series: "${searchQuery}" and filtering for S${episodeInfo.season.toString().padStart(2, '0')}E${episodeInfo.episode.toString().padStart(2, '0')}`);
    }

    getBaseUrl((baseUrl) => {
        searchContent(searchQuery, (searchResults) => {
            if (searchResults.length === 0) {
                console.log('No search results found');
                callback([]);
                return;
            }

            // Find the best matching result based on title similarity
            const bestMatch = findBestMatch(searchQuery, searchResults);
            if (!bestMatch) {
                console.log('No suitable match found');
                callback([]);
                return;
            }

            console.log(`\nProcessing best match: ${bestMatch.title}\n`);

            // Pass episode info to extractStreamingLinks for early filtering
            extractStreamingLinks(bestMatch.url, (streamingLinks) => {
                // Sort links by quality and server priority before returning
                const sortedLinks = sortStreamingLinks(streamingLinks);
                callback(sortedLinks);
            }, episodeInfo.isEpisode ? episodeInfo : null);
        });
    });
}

// Helper function to convert callback-based function to Promise
function promisifyFindStreamingLinks(query) {
    return new Promise((resolve, reject) => {
        try {
            findStreamingLinks(query, (links) => {
                resolve(links);
            });
        } catch (error) {
            reject(error);
        }
    });
}

// Helper function to get movie/show metadata from TMDB
async function getTMDBMetadata(tmdbId, mediaType) {
    const cacheKey = `tmdb_${mediaType}_${tmdbId}`;

    try {
        // Check cache first
        if (CACHE_ENABLED) {
            const cachedData = await getFromCache(cacheKey);
            if (cachedData !== null) {
                console.log(`[MoviesDrive] Cache hit for TMDB metadata: ${cacheKey}`);
                // If cached data is empty, refetch
                if (!cachedData || Object.keys(cachedData).length === 0) {
                    console.log(`[MoviesDrive] Cached TMDB data is empty, refetching: ${cacheKey}`);
                } else {
                    return cachedData;
                }
            } else {
                console.log(`[MoviesDrive] Cache miss for TMDB metadata: ${cacheKey}`);
            }
        }

        const tmdbApiKey = process.env.TMDB_API_KEY;
        if (!tmdbApiKey) {
            console.warn('[MoviesDrive] TMDB API key not found, using TMDB ID only');
            const result = null;
            if (CACHE_ENABLED) {
                await saveToCache(cacheKey, result);
            }
            return result;
        }

        const url = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${tmdbApiKey}`;
        const response = await axios.get(url, { timeout: 10000 });
        const result = response.data;

        // Save to cache
        if (CACHE_ENABLED) {
            await saveToCache(cacheKey, result);
        }

        return result;
    } catch (error) {
        console.error(`[MoviesDrive] Error fetching TMDB metadata:`, error.message);
        const result = null;
        if (CACHE_ENABLED) {
            await saveToCache(cacheKey, result);
        }
        return result;
    }
}

// Helper function to construct search query
function constructSearchQuery(metadata, mediaType, season = null, episode = null) {
    if (!metadata) {
        return null;
    }

    let title = metadata.title || metadata.name;
    let year = '';

    if (metadata.release_date) {
        year = new Date(metadata.release_date).getFullYear();
    } else if (metadata.first_air_date) {
        year = new Date(metadata.first_air_date).getFullYear();
    }

    let query = title;

    // Only add year for movies, not for TV series
    if (year && mediaType === 'movie') {
        query += ` ${year}`;
    }

    // For TV shows, add season and episode info if provided
    if (mediaType === 'tv' && season !== null && episode !== null) {
        const seasonStr = season.toString().padStart(2, '0');
        const episodeStr = episode.toString().padStart(2, '0');
        query += ` S${seasonStr}E${episodeStr}`;
    }

    return query;
}

// Helper function to convert MoviesDrive links to Stremio format
function convertToStremioFormat(links, mediaType) {
    const stremioStreams = links.map(link => {
        // Extract quality from various sources
        let quality = 'Unknown';
        if (link.quality && link.quality !== 'Unknown') {
            quality = link.quality;
        } else if (link.fileName) {
            const qualityMatch = link.fileName.match(/(\d{3,4})[pP]/);
            if (qualityMatch) {
                quality = qualityMatch[1] + 'p';
            }
        }

        // Create name with source and quality info (without size)
        let name = `MoviesDrive`;
        if (link.source && link.source !== 'Unknown') {
            name += ` (${link.source})`;
        }
        if (quality !== 'Unknown') {
            name += ` - ${quality}`;
        }

        // Create title with current details and filename
        let title = link.title || 'MoviesDrive Stream';
        if (link.size && link.size !== 'Unknown') {
            title += `\n${link.size}`;
        }
        if (link.fileName) {
            title += `\n${link.fileName}`;
        }

        return {
            name: name,
            title: title,
            url: link.url,
            quality: quality,
            size: link.size || undefined,
            source: 'MoviesDrive',
            fileName: link.fileName || undefined
        };
    });

    // Remove duplicates based on exact same URL
    const uniqueStreams = [];
    const seenUrls = new Set();

    for (const stream of stremioStreams) {
        if (!seenUrls.has(stream.url)) {
            seenUrls.add(stream.url);
            uniqueStreams.push(stream);
        }
    }

    return uniqueStreams;
}

// Main function to get streams from MoviesDrive
async function getMoviesDriveStreams(tmdbId, mediaType, season = null, episode = null) {
    try {
        console.log(`[MoviesDrive] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);

        // Get metadata from TMDB to construct search query
        const metadata = await getTMDBMetadata(tmdbId, mediaType);
        if (!metadata) {
            console.log(`[MoviesDrive] Could not fetch metadata for TMDB ID: ${tmdbId}`);
            return [];
        }

        // Construct search query
        const searchQuery = constructSearchQuery(metadata, mediaType, season, episode);
        if (!searchQuery) {
            console.log(`[MoviesDrive] Could not construct search query`);
            return [];
        }

        console.log(`[MoviesDrive] Searching for: "${searchQuery}"`);

        // Search for streaming links
        const links = await promisifyFindStreamingLinks(searchQuery);

        if (!links || links.length === 0) {
            console.log(`[MoviesDrive] No streams found for query: "${searchQuery}"`);
            return [];
        }

        console.log(`[MoviesDrive] Found ${links.length} streaming links`);

        // Convert to Stremio format
        const stremioStreams = convertToStremioFormat(links, mediaType);

        return stremioStreams;
    } catch (error) {
        console.error(`[MoviesDrive] Error fetching streams:`, error.message);
        return [];
    }
}

module.exports = { getMoviesDriveStreams };