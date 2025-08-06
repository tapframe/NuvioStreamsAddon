const https = require('https');
const http = require('http');
const { URL } = require('url');
const { JSDOM } = require('jsdom');
const fs = require('fs').promises;
const path = require('path');
const RedisCache = require('../utils/redisCache');

// Configuration
const DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
let cachedDomains = null;

// --- Caching Configuration ---
const CACHE_ENABLED = process.env.DISABLE_CACHE !== 'true';
console.log(`[4KHDHub] Internal cache is ${CACHE_ENABLED ? 'enabled' : 'disabled'}.`);
const CACHE_DIR = process.env.VERCEL ? path.join('/tmp', '.4khdhub_cache') : path.join(__dirname, '.cache', '4khdhub');

// Initialize Redis cache
const redisCache = new RedisCache('4KHDHub');

// --- Caching Helper Functions ---
const ensureCacheDir = async () => {
  if (!CACHE_ENABLED) return;
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      console.error(`[4KHDHub Cache] Error creating cache directory: ${error.message}`);
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

// Utility functions
function base64Decode(str) {
    return Buffer.from(str, 'base64').toString('utf-8');
}

function base64Encode(str) {
    return Buffer.from(str, 'utf-8').toString('base64');
}

function rot13(str) {
    return str.replace(/[A-Za-z]/g, function(char) {
        const start = char <= 'Z' ? 65 : 97;
        return String.fromCharCode(((char.charCodeAt(0) - start + 13) % 26) + start);
    });
}

function validateUrl(url) {
    return new Promise((resolve) => {
        try {
            const urlObj = new URL(url);
            
            // Skip validation for known reliable hosting services
             const trustedHosts = [
                 'pixeldrain.dev',
                 'r2.dev'
             ];
            
            const isTrustedHost = trustedHosts.some(host => urlObj.hostname.includes(host));
            if (isTrustedHost) {
                console.log(`[4KHDHub] Skipping validation for trusted host: ${urlObj.hostname}`);
                resolve(true);
                return;
            }
            
            const protocol = urlObj.protocol === 'https:' ? https : http;
            
            const options = {
                method: 'HEAD',
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            };
            
            const req = protocol.request(url, options, (res) => {
                // Consider 2xx and 3xx status codes as valid, including 206 (Partial Content)
                const isValid = res.statusCode >= 200 && res.statusCode < 400;
                console.log(`[4KHDHub] URL validation for ${url}: ${res.statusCode} - ${isValid ? 'VALID' : 'INVALID'}`);
                res.destroy(); // Close connection immediately
                resolve(isValid);
            });
            
            req.on('error', (err) => {
                console.log(`[4KHDHub] URL validation error for ${url}: ${err.message}`);
                resolve(false);
            });
            
            req.on('timeout', () => {
                console.log(`[4KHDHub] URL validation timeout for ${url}`);
                req.destroy();
                resolve(false);
            });
            
            req.setTimeout(15000);
            req.end();
        } catch (error) {
            console.log(`[4KHDHub] URL validation parse error for ${url}: ${error.message}`);
            resolve(false);
        }
    });
}

function makeRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const isHttps = urlObj.protocol === 'https:';
        const httpModule = isHttps ? https : http;
        
        const requestOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                ...options.headers
            },
            timeout: 30000
        };
        
        const req = httpModule.request(requestOptions, (res) => {
            if (options.allowRedirects === false && (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 307 || res.statusCode === 308)) {
                resolve({ statusCode: res.statusCode, headers: res.headers });
                return;
            }
            
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (options.parseHTML && data) {
                    const dom = new JSDOM(data);
                    resolve({ document: dom.window.document, body: data, statusCode: res.statusCode, headers: res.headers });
                } else {
                    resolve({ body: data, statusCode: res.statusCode, headers: res.headers });
                }
            });
        });
        
        req.on('error', reject);
        req.on('timeout', () => reject(new Error('Request timeout')));
        req.end();
    });
}

// Helper function to decode URL-encoded filenames and make them human-readable
function decodeFilename(filename) {
    if (!filename) return filename;
    
    try {
        // Handle UTF-8 prefix and decode URL encoding
        let decoded = filename;
        
        // Remove UTF-8 prefix if present
        if (decoded.startsWith('UTF-8')) {
            decoded = decoded.substring(5);
        }
        
        // Decode URL encoding (%20 -> space, etc.)
        decoded = decodeURIComponent(decoded);
        
        return decoded;
    } catch (error) {
        console.log(`[4KHDHub] Error decoding filename: ${error.message}`);
        return filename; // Return original if decoding fails
    }
}

function getFilenameFromUrl(url) {
    return new Promise((resolve) => {
        try {
            const urlObj = new URL(url);
            const isHttps = urlObj.protocol === 'https:';
            const httpModule = isHttps ? https : http;
            
            const requestOptions = {
                hostname: urlObj.hostname,
                port: urlObj.port || (isHttps ? 443 : 80),
                path: urlObj.pathname + urlObj.search,
                method: 'HEAD',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                },
                timeout: 10000
            };
            
            const req = httpModule.request(requestOptions, (res) => {
                const contentDisposition = res.headers['content-disposition'];
                let filename = null;
                
                if (contentDisposition) {
                    const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/i);
                    if (filenameMatch && filenameMatch[1]) {
                        filename = filenameMatch[1].replace(/["']/g, '');
                    }
                }
                
                if (!filename) {
                    // Extract from URL path
                    const pathParts = urlObj.pathname.split('/');
                    filename = pathParts[pathParts.length - 1];
                    if (filename && filename.includes('.')) {
                        filename = filename.replace(/\.[^.]+$/, ''); // Remove extension
                    }
                }
                
                // Decode the filename to make it human-readable
                const decodedFilename = decodeFilename(filename);
                resolve(decodedFilename || null);
            });
            
            req.on('error', () => resolve(null));
            req.on('timeout', () => resolve(null));
            req.end();
        } catch (error) {
            resolve(null);
        }
    });
}

function getDomains() {
    if (cachedDomains) {
        return Promise.resolve(cachedDomains);
    }
    
    return makeRequest(DOMAINS_URL)
        .then(response => {
            cachedDomains = JSON.parse(response.body);
            return cachedDomains;
        })
        .catch(error => {
            console.error('[4KHDHub] Failed to fetch domains:', error.message);
            return null;
        });
}

function getRedirectLinks(url) {
    return makeRequest(url)
        .then(response => {
            const doc = response.body;
            const regex = /s\('o','([A-Za-z0-9+/=]+)'|ck\('_wp_http_\d+','([^']+)'/g;
            let combinedString = '';
            let match;
            
            while ((match = regex.exec(doc)) !== null) {
                const extractedValue = match[1] || match[2];
                if (extractedValue) {
                    combinedString += extractedValue;
                }
            }
            
            try {
                const decodedString = base64Decode(rot13(base64Decode(base64Decode(combinedString))));
                const jsonObject = JSON.parse(decodedString);
                const encodedurl = base64Decode(jsonObject.o || '').trim();
                const data = base64Decode(jsonObject.data || '').trim();
                const wphttp1 = (jsonObject.blog_url || '').trim();
                
                if (encodedurl) {
                    return Promise.resolve(encodedurl);
                }
                
                if (wphttp1 && data) {
                    return makeRequest(`${wphttp1}?re=${data}`, { parseHTML: true })
                        .then(resp => resp.document.body.textContent.trim())
                        .catch(() => '');
                }
                
                return Promise.resolve('');
            } catch (e) {
                console.error('[4KHDHub] Error processing links:', e.message);
                return Promise.resolve('');
            }
        })
        .catch(error => {
            console.error('[4KHDHub] Error fetching redirect links:', error.message);
            return Promise.resolve('');
        });
}

function getIndexQuality(str) {
    const match = (str || '').match(/(\d{3,4})[pP]/);
    return match ? parseInt(match[1]) : 2160;
}

function getBaseUrl(url) {
    try {
        const urlObj = new URL(url);
        return `${urlObj.protocol}//${urlObj.host}`;
    } catch (e) {
        return '';
    }
}

function cleanTitle(title) {
    // Decode URL-encoded title first
    const decodedTitle = decodeFilename(title);
    const parts = decodedTitle.split(/[.\-_]/);
    
    const qualityTags = ['WEBRip', 'WEB-DL', 'WEB', 'BluRay', 'HDRip', 'DVDRip', 'HDTV', 'CAM', 'TS', 'R5', 'DVDScr', 'BRRip', 'BDRip', 'DVD', 'PDTV', 'HD'];
    const audioTags = ['AAC', 'AC3', 'DTS', 'MP3', 'FLAC', 'DD5', 'EAC3', 'Atmos'];
    const subTags = ['ESub', 'ESubs', 'Subs', 'MultiSub', 'NoSub', 'EnglishSub', 'HindiSub'];
    const codecTags = ['x264', 'x265', 'H264', 'HEVC', 'AVC'];
    
    const startIndex = parts.findIndex(part => 
        qualityTags.some(tag => part.toLowerCase().includes(tag.toLowerCase()))
    );
    
    const endIndex = parts.map((part, index) => {
        const hasTag = [...subTags, ...audioTags, ...codecTags].some(tag => 
            part.toLowerCase().includes(tag.toLowerCase())
        );
        return hasTag ? index : -1;
    }).filter(index => index !== -1).pop() || -1;
    
    if (startIndex !== -1 && endIndex !== -1 && endIndex >= startIndex) {
        return parts.slice(startIndex, endIndex + 1).join('.');
    } else if (startIndex !== -1) {
        return parts.slice(startIndex).join('.');
    } else {
        return parts.slice(-3).join('.');
    }
}

// Normalize title for better matching
function normalizeTitle(title) {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')  // Remove special characters
        .replace(/\s+/g, ' ')          // Normalize whitespace
        .trim();
}

// Calculate similarity between two strings using Levenshtein distance
function calculateSimilarity(str1, str2) {
    const s1 = normalizeTitle(str1);
    const s2 = normalizeTitle(str2);
    
    if (s1 === s2) return 1.0;
    
    const len1 = s1.length;
    const len2 = s2.length;
    
    if (len1 === 0) return len2 === 0 ? 1.0 : 0.0;
    if (len2 === 0) return 0.0;
    
    const matrix = Array(len1 + 1).fill().map(() => Array(len2 + 1).fill(0));
    
    for (let i = 0; i <= len1; i++) matrix[i][0] = i;
    for (let j = 0; j <= len2; j++) matrix[0][j] = j;
    
    for (let i = 1; i <= len1; i++) {
        for (let j = 1; j <= len2; j++) {
            const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,      // deletion
                matrix[i][j - 1] + 1,      // insertion
                matrix[i - 1][j - 1] + cost // substitution
            );
        }
    }
    
    const maxLen = Math.max(len1, len2);
    return (maxLen - matrix[len1][len2]) / maxLen;
}

// Check if query words are contained in title
function containsWords(title, query) {
    const titleWords = normalizeTitle(title).split(' ');
    const queryWords = normalizeTitle(query).split(' ');
    
    return queryWords.every(queryWord => 
        titleWords.some(titleWord => 
            titleWord.includes(queryWord) || queryWord.includes(titleWord)
        )
    );
}

// Find best matching result from search results
function findBestMatch(results, query) {
    if (results.length === 0) return null;
    if (results.length === 1) return results[0];
    
    // Score each result
    const scoredResults = results.map(result => {
        let score = 0;
        
        // Exact match gets highest score
        if (normalizeTitle(result.title) === normalizeTitle(query)) {
            score += 100;
        }
        
        // Similarity score (0-50 points)
        const similarity = calculateSimilarity(result.title, query);
        score += similarity * 50;
        
        // Word containment bonus (0-30 points)
        if (containsWords(result.title, query)) {
            score += 30;
        }
        
        // Prefer shorter titles (closer matches) (0-10 points)
        const lengthDiff = Math.abs(result.title.length - query.length);
        score += Math.max(0, 10 - lengthDiff / 5);
        
        // Year extraction bonus - prefer titles with years
        if (result.title.match(/\((19|20)\d{2}\)/)) {
            score += 5;
        }
        
        return { ...result, score };
    });
    
    // Sort by score (highest first)
    scoredResults.sort((a, b) => b.score - a.score);
    
    console.log('[4KHDHub] Title matching scores:');
    scoredResults.slice(0, 5).forEach((result, index) => {
        console.log(`${index + 1}. ${result.title} (Score: ${result.score.toFixed(1)})`);
    });
    
    return scoredResults[0];
}

function extractHubCloudLinks(url, referer) {
    console.log(`[4KHDHub] Starting HubCloud extraction for: ${url}`);
    const baseUrl = getBaseUrl(url);
    
    return makeRequest(url, { parseHTML: true })
        .then(response => {
            const document = response.document;
            console.log(`[4KHDHub] Got HubCloud page, looking for download element...`);
            
            // Check if this is already a hubcloud.php URL
            let href;
            if (url.includes('hubcloud.php')) {
                href = url;
                console.log(`[4KHDHub] Already a hubcloud.php URL: ${href}`);
            } else {
                const downloadElement = document.querySelector('#download');
                if (!downloadElement) {
                    console.log('[4KHDHub] Download element #download not found, trying alternatives...');
                    // Try alternative selectors
                    const alternatives = ['a[href*="hubcloud.php"]', '.download-btn', 'a[href*="download"]'];
                    let found = false;
                    
                    for (const selector of alternatives) {
                        const altElement = document.querySelector(selector);
                        if (altElement) {
                            const rawHref = altElement.getAttribute('href');
                            if (rawHref) {
                                href = rawHref.startsWith('http') ? rawHref : `${baseUrl.replace(/\/$/, '')}/${rawHref.replace(/^\//, '')}`;
                                console.log(`[4KHDHub] Found download link with selector ${selector}: ${href}`);
                                found = true;
                                break;
                            }
                        }
                    }
                    
                    if (!found) {
                        throw new Error('Download element not found with any selector');
                    }
                } else {
                    const rawHref = downloadElement.getAttribute('href');
                    if (!rawHref) {
                        throw new Error('Download href not found');
                    }
                    
                    href = rawHref.startsWith('http') ? rawHref : `${baseUrl.replace(/\/$/, '')}/${rawHref.replace(/^\//, '')}`;
                    console.log(`[4KHDHub] Found download href: ${href}`);
                }
            }
            
            console.log(`[4KHDHub] Making request to HubCloud download page: ${href}`);
            return makeRequest(href, { parseHTML: true });
        })
        .then(response => {
            const document = response.document;
            const results = [];
            
            console.log(`[4KHDHub] Processing HubCloud download page...`);
            
            // Extract quality and size information
            const size = document.querySelector('i#size')?.textContent || '';
            const header = document.querySelector('div.card-header')?.textContent || '';
            const quality = getIndexQuality(header);
            const headerDetails = cleanTitle(header);
            
            console.log(`[4KHDHub] Extracted info - Size: ${size}, Header: ${header}, Quality: ${quality}, HeaderDetails: ${headerDetails}`);
            
            // Extract just the quality for clean naming
            const qualityLabel = quality ? ` - ${quality}p` : '';
            
            // We'll build the title format later after getting actual filename from HEAD request
            
            // Find download buttons
            const downloadButtons = document.querySelectorAll('div.card-body h2 a.btn');
            console.log(`[4KHDHub] Found ${downloadButtons.length} download buttons`);
            
            if (downloadButtons.length === 0) {
                // Try alternative selectors for download buttons
                const altSelectors = ['a.btn', '.btn', 'a[href]'];
                for (const selector of altSelectors) {
                    const altButtons = document.querySelectorAll(selector);
                    if (altButtons.length > 0) {
                        console.log(`[4KHDHub] Found ${altButtons.length} buttons with alternative selector: ${selector}`);
                        altButtons.forEach((btn, index) => {
                            const link = btn.getAttribute('href');
                            const text = btn.textContent;
                            console.log(`[4KHDHub] Button ${index + 1}: ${text} -> ${link}`);
                        });
                        break;
                    }
                }
            }
            
            const promises = Array.from(downloadButtons).map((button, index) => {
                return new Promise((resolve) => {
                    const link = button.getAttribute('href');
                    const text = button.textContent;
                    
                    console.log(`[4KHDHub] Processing button ${index + 1}: "${text}" -> ${link}`);
                    
                    if (!link) {
                        console.log(`[4KHDHub] Button ${index + 1} has no link`);
                        resolve(null);
                        return;
                    }
                    
                    const buttonBaseUrl = getBaseUrl(link);
                    
                    if (text.includes('FSL Server')) {
                        console.log(`[4KHDHub] Button ${index + 1} is FSL Server`);
                        // Get actual filename from HEAD request
                        getFilenameFromUrl(link)
                            .then(actualFilename => {
                                const displayFilename = actualFilename || headerDetails || 'Unknown';
                                const titleParts = [];
                                if (displayFilename) titleParts.push(displayFilename);
                                if (size) titleParts.push(size);
                                const finalTitle = titleParts.join('\n');
                                
                                resolve({
                                    name: `4KHDHub - FSL Server${qualityLabel}`,
                                    title: finalTitle,
                                    url: link,
                                    quality: quality
                                });
                            })
                            .catch(() => {
                                const displayFilename = headerDetails || 'Unknown';
                                const titleParts = [];
                                if (displayFilename) titleParts.push(displayFilename);
                                if (size) titleParts.push(size);
                                const finalTitle = titleParts.join('\n');
                                
                                resolve({
                                    name: `4KHDHub - FSL Server${qualityLabel}`,
                                    title: finalTitle,
                                    url: link,
                                    quality: quality
                                });
                            });
                    } else if (text.includes('Download File')) {
                        console.log(`[4KHDHub] Button ${index + 1} is Download File`);
                        // Get actual filename from HEAD request
                        getFilenameFromUrl(link)
                            .then(actualFilename => {
                                const displayFilename = actualFilename || headerDetails || 'Unknown';
                                const titleParts = [];
                                if (displayFilename) titleParts.push(displayFilename);
                                if (size) titleParts.push(size);
                                const finalTitle = titleParts.join('\n');
                                
                                resolve({
                                    name: `4KHDHub - HubCloud${qualityLabel}`,
                                    title: finalTitle,
                                    url: link,
                                    quality: quality
                                });
                            })
                            .catch(() => {
                                const displayFilename = headerDetails || 'Unknown';
                                const titleParts = [];
                                if (displayFilename) titleParts.push(displayFilename);
                                if (size) titleParts.push(size);
                                const finalTitle = titleParts.join('\n');
                                
                                resolve({
                                    name: `4KHDHub - HubCloud${qualityLabel}`,
                                    title: finalTitle,
                                    url: link,
                                    quality: quality
                                });
                            });
                    } else if (text.includes('BuzzServer')) {
                        console.log(`[4KHDHub] Button ${index + 1} is BuzzServer, following redirect...`);
                        // Handle BuzzServer redirect
                        makeRequest(`${link}/download`, { 
                            parseHTML: false,
                            allowRedirects: false,
                            headers: { 'Referer': link }
                        })
                        .then(response => {
                            const redirectUrl = response.headers['hx-redirect'] || response.headers['location'];
                            if (redirectUrl) {
                                console.log(`[4KHDHub] BuzzServer redirect found: ${redirectUrl}`);
                                const finalUrl = buttonBaseUrl + redirectUrl;
                                // Get actual filename from HEAD request
                                getFilenameFromUrl(finalUrl)
                                    .then(actualFilename => {
                                        const displayFilename = actualFilename || headerDetails || 'Unknown';
                                        const titleParts = [];
                                        if (displayFilename) titleParts.push(displayFilename);
                                        if (size) titleParts.push(size);
                                        const finalTitle = titleParts.join('\n');
                                        
                                        resolve({
                                            name: `4KHDHub - BuzzServer${qualityLabel}`,
                                            title: finalTitle,
                                            url: finalUrl,
                                            quality: quality
                                        });
                                    })
                                    .catch(() => {
                                        const displayFilename = headerDetails || 'Unknown';
                                        const titleParts = [];
                                        if (displayFilename) titleParts.push(displayFilename);
                                        if (size) titleParts.push(size);
                                        const finalTitle = titleParts.join('\n');
                                        
                                        resolve({
                                            name: `4KHDHub - BuzzServer${qualityLabel}`,
                                            title: finalTitle,
                                            url: finalUrl,
                                            quality: quality
                                        });
                                    });
                            } else {
                                console.log(`[4KHDHub] BuzzServer redirect not found`);
                                resolve(null);
                            }
                        })
                        .catch(err => {
                            console.log(`[4KHDHub] BuzzServer redirect failed: ${err.message}`);
                            resolve(null);
                        });
                    } else if (link.includes('pixeldra')) {
                        console.log(`[4KHDHub] Button ${index + 1} is Pixeldrain`);
                        
                        // Convert pixeldrain.net/u/ID format to pixeldrain.net/api/file/ID format
                        let convertedLink = link;
                        const pixeldrainMatch = link.match(/pixeldrain\.net\/u\/([a-zA-Z0-9]+)/);
                        if (pixeldrainMatch) {
                            const fileId = pixeldrainMatch[1];
                            convertedLink = `https://pixeldrain.net/api/file/${fileId}`;
                            console.log(`[4KHDHub] Converted Pixeldrain URL from ${link} to ${convertedLink}`);
                        }
                        
                        // Get actual filename from HEAD request
                        getFilenameFromUrl(convertedLink)
                            .then(actualFilename => {
                                const displayFilename = actualFilename || headerDetails || 'Unknown';
                                const titleParts = [];
                                if (displayFilename) titleParts.push(displayFilename);
                                if (size) titleParts.push(size);
                                const finalTitle = titleParts.join('\n');
                                
                                resolve({
                                    name: `4KHDHub - Pixeldrain${qualityLabel}`,
                                    title: finalTitle,
                                    url: convertedLink,
                                    quality: quality
                                });
                            })
                            .catch(() => {
                                const displayFilename = headerDetails || 'Unknown';
                                const titleParts = [];
                                if (displayFilename) titleParts.push(displayFilename);
                                if (size) titleParts.push(size);
                                const finalTitle = titleParts.join('\n');
                                
                                resolve({
                                    name: `4KHDHub - Pixeldrain${qualityLabel}`,
                                    title: finalTitle,
                                    url: convertedLink,
                                    quality: quality
                                });
                            });
                    } else if (text.includes('S3 Server')) {
                        console.log(`[4KHDHub] Button ${index + 1} is S3 Server`);
                        // Get actual filename from HEAD request
                        getFilenameFromUrl(link)
                            .then(actualFilename => {
                                const displayFilename = actualFilename || headerDetails || 'Unknown';
                                const titleParts = [];
                                if (displayFilename) titleParts.push(displayFilename);
                                if (size) titleParts.push(size);
                                const finalTitle = titleParts.join('\n');
                                
                                resolve({
                                    name: `4KHDHub - S3 Server${qualityLabel}`,
                                    title: finalTitle,
                                    url: link,
                                    quality: quality
                                });
                            })
                            .catch(() => {
                                const displayFilename = headerDetails || 'Unknown';
                                const titleParts = [];
                                if (displayFilename) titleParts.push(displayFilename);
                                if (size) titleParts.push(size);
                                const finalTitle = titleParts.join('\n');
                                
                                resolve({
                                    name: `4KHDHub - S3 Server${qualityLabel}`,
                                    title: finalTitle,
                                    url: link,
                                    quality: quality
                                });
                            });
                    } else if (text.includes('10Gbps')) {
                        console.log(`[4KHDHub] Button ${index + 1} is 10Gbps server, following redirects...`);
                        // Handle 10Gbps server with multiple redirects
                        let currentLink = link;
                        
                        const followRedirects = () => {
                            return makeRequest(currentLink, { 
                                parseHTML: false,
                                allowRedirects: false 
                            })
                            .then(response => {
                                const redirectUrl = response.headers['location'];
                                if (!redirectUrl) {
                                    throw new Error('No redirect found');
                                }
                                
                                console.log(`[4KHDHub] 10Gbps redirect: ${redirectUrl}`);
                                
                                if (redirectUrl.includes('id=')) {
                                    // Final redirect, extract the link parameter
                                    const finalLink = redirectUrl.split('link=')[1];
                                    if (finalLink) {
                                        console.log(`[4KHDHub] 10Gbps final link: ${finalLink}`);
                                        const decodedUrl = decodeURIComponent(finalLink);
                                        // Get actual filename from HEAD request
                                        return getFilenameFromUrl(decodedUrl)
                                            .then(actualFilename => {
                                                const displayFilename = actualFilename || headerDetails || 'Unknown';
                                                const titleParts = [];
                                                if (displayFilename) titleParts.push(displayFilename);
                                                if (size) titleParts.push(size);
                                                const finalTitle = titleParts.join('\n');
                                                
                                                return {
                                                    name: `4KHDHub - 10Gbps Server${qualityLabel}`,
                                                    title: finalTitle,
                                                    url: decodedUrl,
                                                    quality: quality
                                                };
                                            })
                                            .catch(() => {
                                                const displayFilename = headerDetails || 'Unknown';
                                                const titleParts = [];
                                                if (displayFilename) titleParts.push(displayFilename);
                                                if (size) titleParts.push(size);
                                                const finalTitle = titleParts.join('\n');
                                                
                                                return {
                                                    name: `4KHDHub - 10Gbps Server${qualityLabel}`,
                                                    title: finalTitle,
                                                    url: decodedUrl,
                                                    quality: quality
                                                };
                                            });
                                    }
                                    throw new Error('Final link not found');
                                } else {
                                    currentLink = redirectUrl;
                                    return followRedirects();
                                }
                            });
                        };
                        
                        followRedirects()
                            .then(result => {
                                console.log(`[4KHDHub] 10Gbps processing completed`);
                                resolve(result);
                            })
                            .catch(err => {
                                console.log(`[4KHDHub] 10Gbps processing failed: ${err.message}`);
                                resolve(null);
                            });
                    } else {
                        console.log(`[4KHDHub] Button ${index + 1} is generic link`);
                        // Generic link - Get actual filename from HEAD request
                        getFilenameFromUrl(link)
                            .then(actualFilename => {
                                const displayFilename = actualFilename || headerDetails || 'Unknown';
                                const titleParts = [];
                                if (displayFilename) titleParts.push(displayFilename);
                                if (size) titleParts.push(size);
                                const finalTitle = titleParts.join('\n');
                                
                                resolve({
                                    name: `4KHDHub - HubCloud${qualityLabel}`,
                                    title: finalTitle,
                                    url: link,
                                    quality: quality
                                });
                            })
                            .catch(() => {
                                const displayFilename = headerDetails || 'Unknown';
                                const titleParts = [];
                                if (displayFilename) titleParts.push(displayFilename);
                                if (size) titleParts.push(size);
                                const finalTitle = titleParts.join('\n');
                                
                                resolve({
                                    name: `4KHDHub - HubCloud${qualityLabel}`,
                                    title: finalTitle,
                                    url: link,
                                    quality: quality
                                });
                            });
                    }
                });
            });
            
            return Promise.all(promises)
                .then(results => {
                    const validResults = results.filter(result => result !== null);
                    console.log(`[4KHDHub] HubCloud extraction completed, found ${validResults.length} valid links`);
                    return validResults;
                });
        })
        .catch(error => {
            console.error(`[4KHDHub] HubCloud extraction error for ${url}:`, error.message);
            return [];
        });
}

function searchContent(query) {
    return getDomains()
        .then(domains => {
            if (!domains || !domains['4khdhub']) {
                throw new Error('Failed to get domain information');
            }
            
            const baseUrl = domains['4khdhub'];
            const searchUrl = `${baseUrl}/?s=${encodeURIComponent(query)}`;
            return makeRequest(searchUrl, { parseHTML: true })
                .then(response => ({ response, baseUrl }));
        })
        .then(({ response, baseUrl }) => {
            const document = response.document;
            const results = [];
            
            const cards = document.querySelectorAll('div.card-grid a');
            cards.forEach(card => {
                const title = card.querySelector('h3')?.textContent;
                const href = card.getAttribute('href');
                const posterUrl = card.querySelector('img')?.getAttribute('src');
                
                if (title && href) {
                    // Convert relative URLs to absolute URLs
                    const absoluteUrl = href.startsWith('http') ? href : `${baseUrl}${href.startsWith('/') ? '' : '/'}${href}`;
                    results.push({
                        title: title.trim(),
                        url: absoluteUrl,
                        poster: posterUrl || ''
                    });
                }
            });
            
            return results;
        });
}

function loadContent(url) {
    return makeRequest(url, { parseHTML: true })
        .then(response => {
            const document = response.document;
            const title = document.querySelector('h1.page-title')?.textContent?.split('(')[0]?.trim() || '';
            const poster = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
            const tags = Array.from(document.querySelectorAll('div.mt-2 span.badge')).map(el => el.textContent);
            const year = parseInt(document.querySelector('div.mt-2 span')?.textContent) || null;
            const description = document.querySelector('div.content-section p.mt-4')?.textContent?.trim() || '';
            const trailer = document.querySelector('#trailer-btn')?.getAttribute('data-trailer-url') || '';
            
            const isMovie = tags.includes('Movies');
            
            // Try multiple selectors to find download links
            let hrefs = [];
            const selectors = [
                'div.download-item a',
                '.download-item a',
                'a[href*="hubdrive"]',
                'a[href*="hubcloud"]',
                'a[href*="drive"]',
                '.btn[href]',
                'a.btn'
            ];
            
            for (const selector of selectors) {
                const links = Array.from(document.querySelectorAll(selector))
                    .map(a => a.getAttribute('href'))
                    .filter(href => href && href.trim());
                if (links.length > 0) {
                    hrefs = links;
                    console.log(`[4KHDHub] Found ${links.length} links using selector: ${selector}`);
                    break;
                }
            }
            
            if (hrefs.length === 0) {
                console.log('[4KHDHub] No download links found. Available links on page:');
                const allLinks = Array.from(document.querySelectorAll('a[href]'))
                    .map(a => a.getAttribute('href'))
                    .filter(href => href && href.includes('http'))
                    .slice(0, 10); // Show first 10 links
                console.log(allLinks);
            }
            
            const content = {
                title,
                poster,
                tags,
                year,
                description,
                trailer,
                type: isMovie ? 'movie' : 'series'
            };
            
            if (isMovie) {
                content.downloadLinks = hrefs;
                return Promise.resolve(content);
            } else {
                // Handle TV series episodes
                const episodes = [];
                const episodesMap = new Map();
                
                console.log(`[4KHDHub] Looking for episode structure...`);
                const seasonItems = document.querySelectorAll('div.episodes-list div.season-item');
                console.log(`[4KHDHub] Found ${seasonItems.length} season items`);
                
                if (seasonItems.length === 0) {
                    // Try alternative episode structure selectors
                    const altSelectors = [
                        'div.season-item',
                        '.episode-item',
                        '.episode-download',
                        'div[class*="episode"]',
                        'div[class*="season"]'
                    ];
                    
                    for (const selector of altSelectors) {
                        const items = document.querySelectorAll(selector);
                        if (items.length > 0) {
                            console.log(`[4KHDHub] Found ${items.length} items with selector: ${selector}`);
                            break;
                        }
                    }
                    
                    // If no episode structure found, treat all found links as general series links
                    if (hrefs.length > 0) {
                        console.log(`[4KHDHub] No episode structure found, using general links for series`);
                        // Create a single episode entry with all links
                        content.episodes = [{
                            season: 1,
                            episode: 1,
                            downloadLinks: hrefs
                        }];
                    } else {
                        content.episodes = [];
                    }
                } else {
                    seasonItems.forEach(seasonElement => {
                        const seasonText = seasonElement.querySelector('div.episode-number')?.textContent || '';
                        const seasonMatch = seasonText.match(/S?([1-9][0-9]*)/); 
                        const season = seasonMatch ? parseInt(seasonMatch[1]) : null;
                        
                        const episodeItems = seasonElement.querySelectorAll('div.episode-download-item');
                        episodeItems.forEach(episodeItem => {
                            const episodeText = episodeItem.querySelector('div.episode-file-info span.badge-psa')?.textContent || '';
                            const episodeMatch = episodeText.match(/Episode-0*([1-9][0-9]*)/); 
                            const episode = episodeMatch ? parseInt(episodeMatch[1]) : null;
                            
                            const episodeHrefs = Array.from(episodeItem.querySelectorAll('a'))
                                .map(a => a.getAttribute('href'))
                                .filter(href => href && href.trim());
                            
                            if (season && episode && episodeHrefs.length > 0) {
                                const key = `${season}-${episode}`;
                                if (!episodesMap.has(key)) {
                                    episodesMap.set(key, {
                                        season,
                                        episode,
                                        downloadLinks: []
                                    });
                                }
                                episodesMap.get(key).downloadLinks.push(...episodeHrefs);
                            }
                        });
                    });
                    
                    content.episodes = Array.from(episodesMap.values()).map(ep => ({
                        ...ep,
                        downloadLinks: [...new Set(ep.downloadLinks)] // Remove duplicates
                    }));
                }
                
                console.log(`[4KHDHub] Found ${content.episodes.length} episodes with links`);
                return Promise.resolve(content);
            }
        });
}

function extractStreamingLinks(downloadLinks) {
    console.log(`[4KHDHub] Processing ${downloadLinks.length} download links...`);
    
    const promises = downloadLinks.map((link, index) => {
        return new Promise((resolve) => {
            console.log(`[4KHDHub] Processing link ${index + 1}: ${link}`);
            
            // Check if link needs redirect processing
            if (link.toLowerCase().includes('id=')) {
                console.log(`[4KHDHub] Link ${index + 1} needs redirect processing`);
                getRedirectLinks(link)
                    .then(resolvedLink => {
                        if (resolvedLink) {
                            console.log(`[4KHDHub] Link ${index + 1} resolved to: ${resolvedLink}`);
                            processExtractorLink(resolvedLink, resolve, index + 1);
                        } else {
                            console.log(`[4KHDHub] Link ${index + 1} redirect resolution failed`);
                            resolve(null);
                        }
                    })
                    .catch(err => {
                        console.error(`[4KHDHub] Redirect failed for link ${index + 1} (${link}):`, err.message);
                        resolve(null);
                    });
            } else {
                processExtractorLink(link, resolve, index + 1);
            }
        });
    });
    
    return Promise.all(promises)
        .then(results => {
            const validResults = results.filter(result => result !== null);
            const flatResults = validResults.flat();
            // Filter out .zip files
            const filteredResults = flatResults.filter(link => {
                return link && link.url && !link.url.toLowerCase().endsWith('.zip');
            });
            // Note: Link count will be logged after validation completes
            return filteredResults;
        });
}

function extractHubDriveLinks(url, referer) {
    console.log(`[4KHDHub] Starting HubDrive extraction for: ${url}`);
    
    return makeRequest(url, { parseHTML: true })
        .then(response => {
            const document = response.document;
            
            console.log(`[4KHDHub] Got HubDrive page, looking for download button...`);
            
            // Extract filename and size information
            const size = document.querySelector('i#size')?.textContent || '';
            const header = document.querySelector('div.card-header')?.textContent || '';
            const quality = getIndexQuality(header);
            const headerDetails = cleanTitle(header);
            
            console.log(`[4KHDHub] HubDrive extracted info - Size: ${size}, Header: ${header}, Quality: ${quality}, HeaderDetails: ${headerDetails}`);
            
            // Extract filename from header for title display
            let filename = headerDetails || header || 'Unknown';
            // Clean up the filename by removing common prefixes and file extensions
            filename = filename.replace(/^4kHDHub\.com\s*[-_]?\s*/i, '')
                              .replace(/\.[a-z0-9]{2,4}$/i, '')
                              .replace(/[._]/g, ' ')
                              .trim();
            
            // Use the exact selector from Kotlin code
            const downloadBtn = document.querySelector('.btn.btn-primary.btn-user.btn-success1.m-1');
            
            if (!downloadBtn) {
                console.log('[4KHDHub] Primary download button not found, trying alternative selectors...');
                // Try alternative selectors
                const alternatives = [
                    'a.btn.btn-primary',
                    '.btn-primary',
                    'a[href*="download"]',
                    'a.btn'
                ];
                
                let foundBtn = null;
                for (const selector of alternatives) {
                    foundBtn = document.querySelector(selector);
                    if (foundBtn) {
                        console.log(`[4KHDHub] Found download button with selector: ${selector}`);
                        break;
                    }
                }
                
                if (!foundBtn) {
                    throw new Error('Download button not found with any selector');
                }
                
                const href = foundBtn.getAttribute('href');
                if (!href) {
                    throw new Error('Download link not found');
                }
                
                console.log(`[4KHDHub] Found HubDrive download link: ${href}`);
                return processHubDriveLink(href, referer, filename, size, quality);
            }
            
            const href = downloadBtn.getAttribute('href');
            if (!href) {
                throw new Error('Download link not found');
            }
            
            console.log(`[4KHDHub] Found HubDrive download link: ${href}`);
            return processHubDriveLink(href, referer, filename, size, quality);
        })
        .catch(error => {
            console.error(`[4KHDHub] Error extracting HubDrive links for ${url}:`, error.message);
            return [];
        });
}

function processHubDriveLink(href, referer, filename = 'Unknown', size = '', quality = 1080) {
    // Check if it's a HubCloud link
    if (href.toLowerCase().includes('hubcloud')) {
        console.log('[4KHDHub] HubDrive link redirects to HubCloud, processing...');
        return extractHubCloudLinks(href, '4KHDHub');
    } else {
        console.log('[4KHDHub] HubDrive direct link found');
        // Direct link or other extractor
        const qualityLabel = quality ? ` - ${quality}p` : '';
        
        // Build labelExtras like the original extractor
        const labelExtras = [];
        if (filename && filename !== 'Unknown') labelExtras.push(`[${filename}]`);
        if (size) labelExtras.push(`[${size}]`);
        const labelExtra = labelExtras.join('');
        
        // Get actual filename from HEAD request
        return getFilenameFromUrl(href)
            .then(actualFilename => {
                const displayFilename = actualFilename || filename || 'Unknown';
                const titleParts = [];
                if (displayFilename) titleParts.push(displayFilename);
                if (size) titleParts.push(size);
                const finalTitle = titleParts.join('\n');
                
                return [{
                    name: `4KHDHub - HubDrive${qualityLabel}`,
                    title: finalTitle,
                    url: href,
                    quality: quality
                }];
            })
            .catch(() => {
                const displayFilename = filename || 'Unknown';
                const titleParts = [];
                if (displayFilename) titleParts.push(displayFilename);
                if (size) titleParts.push(size);
                const finalTitle = titleParts.join('\n');
                
                return [{
                    name: `4KHDHub - HubDrive${qualityLabel}`,
                    title: finalTitle,
                    url: href,
                    quality: quality
                }];
            });
    }
}

function processExtractorLink(link, resolve, linkNumber) {
    const linkLower = link.toLowerCase();
    
    console.log(`[4KHDHub] Checking extractors for link ${linkNumber}: ${link}`);
    
    if (linkLower.includes('hubdrive')) {
        console.log(`[4KHDHub] Link ${linkNumber} matched HubDrive extractor`);
        extractHubDriveLinks(link, '4KHDHub')
            .then(links => {
                console.log(`[4KHDHub] HubDrive extraction completed for link ${linkNumber}:`, links);
                resolve(links);
            })
            .catch(err => {
                console.error(`[4KHDHub] HubDrive extraction failed for link ${linkNumber} (${link}):`, err.message);
                resolve(null);
            });
    } else if (linkLower.includes('hubcloud')) {
        console.log(`[4KHDHub] Link ${linkNumber} matched HubCloud extractor`);
        extractHubCloudLinks(link, '4KHDHub')
            .then(links => {
                console.log(`[4KHDHub] HubCloud extraction completed for link ${linkNumber}:`, links);
                resolve(links);
            })
            .catch(err => {
                console.error(`[4KHDHub] HubCloud extraction failed for link ${linkNumber} (${link}):`, err.message);
                resolve(null);
            });
    } else {
        console.log(`[4KHDHub] No extractor matched for link ${linkNumber}: ${link}`);
        // Try to extract any direct streaming URLs from the link
        if (link.includes('http') && (link.includes('.mp4') || link.includes('.mkv') || link.includes('.avi'))) {
            console.log(`[4KHDHub] Link ${linkNumber} appears to be a direct video link`);
            // Extract filename from URL
            const urlParts = link.split('/');
            const filename = urlParts[urlParts.length - 1].replace(/\.[^/.]+$/, '').replace(/[._]/g, ' ');
            
            // Build labelExtras like the original extractor
            const labelExtras = [];
            if (filename) labelExtras.push(`[${filename}]`);
            labelExtras.push('[Direct Link]');
            const labelExtra = labelExtras.join('');
            
            // Get actual filename from HEAD request
            getFilenameFromUrl(link)
                .then(actualFilename => {
                    const displayFilename = actualFilename || filename || 'Unknown';
                    const titleParts = [];
                    if (displayFilename) titleParts.push(displayFilename);
                    titleParts.push('[Direct Link]');
                    const finalTitle = titleParts.join('\n');
                    
                    resolve([{
                        name: '4KHDHub Direct Link',
                        title: finalTitle,
                        url: link,
                        quality: 1080
                    }]);
                })
                .catch(() => {
                    const displayFilename = filename || 'Unknown';
                    const titleParts = [];
                    if (displayFilename) titleParts.push(displayFilename);
                    titleParts.push('[Direct Link]');
                    const finalTitle = titleParts.join('\n');
                    
                    resolve([{
                        name: '4KHDHub Direct Link',
                        title: finalTitle,
                        url: link,
                        quality: 1080
                    }]);
                });
        } else {
            resolve(null);
        }
    }
}

// Helper function to get TMDB details
async function getTMDBDetails(tmdbId, mediaType) {
    const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
    
    try {
        console.log(`[4KHDHub] Fetching ${mediaType} details for TMDB ID: ${tmdbId}`);
        const response = await makeRequest(`https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${TMDB_API_KEY}`);
        const data = JSON.parse(response.body);
        
        if (mediaType === 'movie') {
            return {
                title: data.title,
                original_title: data.original_title,
                year: data.release_date ? data.release_date.split('-')[0] : null
            };
        } else {
            return {
                title: data.name,
                original_title: data.original_name,
                year: data.first_air_date ? data.first_air_date.split('-')[0] : null
            };
        }
    } catch (error) {
        console.error(`[4KHDHub] Error fetching details from TMDB:`, error.message);
        return null;
    }
}

// Main function to get streams for the addon
async function get4KHDHubStreams(tmdbId, type, season = null, episode = null) {
    try {
        console.log(`[4KHDHub] Starting search for TMDB ID: ${tmdbId}, Type: ${type}${season ? `, Season: ${season}` : ''}${episode ? `, Episode: ${episode}` : ''}`);
        
        // Create cache key for resolved file hosting URLs
        const cacheKey = `4khdhub_resolved_urls_v1_${tmdbId}_${type}${season ? `_s${season}e${episode}` : ''}`;
        
        let streamingLinks = [];
        
        // 1. Check cache for resolved file hosting URLs first
        let cachedResolvedUrls = await getFromCache(cacheKey);
        if (cachedResolvedUrls && cachedResolvedUrls.length > 0) {
            console.log(`[4KHDHub] Cache HIT for ${cacheKey}. Using ${cachedResolvedUrls.length} cached resolved URLs.`);
            // Process cached resolved URLs directly to final streaming links
            console.log(`[4KHDHub] Processing ${cachedResolvedUrls.length} cached resolved URLs to get streaming links.`);
            streamingLinks = await extractStreamingLinks(cachedResolvedUrls);
        } else {
            if (cachedResolvedUrls && cachedResolvedUrls.length === 0) {
                console.log(`[4KHDHub] Cache contains empty data for ${cacheKey}. Refetching from source.`);
            } else {
                console.log(`[4KHDHub] Cache MISS for ${cacheKey}. Fetching from source.`);
            }
            
            // Map type to TMDB API format
            const tmdbType = type === 'series' ? 'tv' : type;
            
            // Get TMDB details to get the actual title
            const tmdbDetails = await getTMDBDetails(tmdbId, tmdbType);
            if (!tmdbDetails || !tmdbDetails.title) {
                console.log(`[4KHDHub] Could not fetch TMDB details for ID: ${tmdbId}`);
                return [];
            }
            
            console.log(`[4KHDHub] TMDB Details: ${tmdbDetails.title} (${tmdbDetails.year || 'N/A'})`);
            
            // Search using the actual title
            const searchQuery = tmdbDetails.title;
            const searchResults = await searchContent(searchQuery);
            console.log(`[4KHDHub] Found ${searchResults.length} search results`);
            
            if (searchResults.length === 0) {
                return [];
            }
            
            // Find the best matching result using title similarity
            const bestMatch = findBestMatch(searchResults, tmdbDetails.title);
            if (!bestMatch) {
                console.log(`[4KHDHub] No suitable match found for: ${tmdbDetails.title}`);
                return [];
            }
            
            console.log(`[4KHDHub] Using best match: ${bestMatch.title}`);
            
            const content = await loadContent(bestMatch.url);
            
            let downloadLinks = [];
            
            if (type === 'movie') {
                downloadLinks = content.downloadLinks || [];
            } else if ((type === 'series' || type === 'tv') && season && episode) {
                console.log(`[4KHDHub] Looking for Season ${season}, Episode ${episode}`);
                console.log(`[4KHDHub] Available episodes:`, content.episodes?.map(ep => `S${ep.season}E${ep.episode} (${ep.downloadLinks?.length || 0} links)`));
                
                const targetEpisode = content.episodes?.find(ep => 
                    ep.season === parseInt(season) && ep.episode === parseInt(episode)
                );
                
                if (targetEpisode) {
                    console.log(`[4KHDHub] Found target episode S${targetEpisode.season}E${targetEpisode.episode} with ${targetEpisode.downloadLinks?.length || 0} links`);
                    downloadLinks = targetEpisode.downloadLinks || [];
                } else {
                    console.log(`[4KHDHub] Target episode S${season}E${episode} not found`);
                }
            }
            
            if (downloadLinks.length === 0) {
                console.log(`[4KHDHub] No download links found`);
                return [];
            }
            
            // Resolve redirect URLs to actual file hosting URLs
            console.log(`[4KHDHub] Resolving ${downloadLinks.length} redirect URLs to file hosting URLs...`);
            const resolvedUrls = [];
            
            for (let i = 0; i < downloadLinks.length; i++) {
                const link = downloadLinks[i];
                console.log(`[4KHDHub] Resolving link ${i + 1}/${downloadLinks.length}: ${link}`);
                
                try {
                    if (link.toLowerCase().includes('id=')) {
                        // This is a redirect URL, resolve it
                        const resolvedUrl = await getRedirectLinks(link);
                        if (resolvedUrl && resolvedUrl.trim()) {
                            console.log(`[4KHDHub] Link ${i + 1} resolved to: ${resolvedUrl}`);
                            resolvedUrls.push(resolvedUrl);
                        } else {
                            console.log(`[4KHDHub] Link ${i + 1} resolution failed or returned empty`);
                        }
                    } else {
                        // Direct URL, use as-is
                        console.log(`[4KHDHub] Link ${i + 1} is direct URL: ${link}`);
                        resolvedUrls.push(link);
                    }
                } catch (error) {
                    console.error(`[4KHDHub] Error resolving link ${i + 1} (${link}):`, error.message);
                }
            }
            
            if (resolvedUrls.length === 0) {
                console.log(`[4KHDHub] No URLs resolved successfully`);
                return [];
            }
            
            // Cache the resolved file hosting URLs
            console.log(`[4KHDHub] Caching ${resolvedUrls.length} resolved URLs for key: ${cacheKey}`);
            await saveToCache(cacheKey, resolvedUrls);
            
            // Process resolved URLs to get final streaming links
            console.log(`[4KHDHub] Processing ${resolvedUrls.length} resolved URLs to get streaming links.`);
            streamingLinks = await extractStreamingLinks(resolvedUrls);
        }
        
        // Filter out suspicious AMP/redirect URLs
        const filteredLinks = streamingLinks.filter(link => {
            const url = link.url.toLowerCase();
            const suspiciousPatterns = [
                'www-google-com.cdn.ampproject.org',
                'bloggingvector.shop',
                'cdn.ampproject.org'
            ];
            
            const isSuspicious = suspiciousPatterns.some(pattern => url.includes(pattern));
            if (isSuspicious) {
                console.log(`[4KHDHub] Filtered out suspicious URL: ${link.url}`);
                return false;
            }
            return true;
        });
        
        // Remove duplicates based on URL
        const uniqueLinks = [];
        const seenUrls = new Set();
        
        for (const link of filteredLinks) {
            if (!seenUrls.has(link.url)) {
                seenUrls.add(link.url);
                uniqueLinks.push(link);
            }
        }
        
        console.log(`[4KHDHub] Processing ${uniqueLinks.length} unique links (${streamingLinks.length - filteredLinks.length} suspicious URLs filtered, ${filteredLinks.length - uniqueLinks.length} duplicates removed)`);
        
        // Validate URLs if DISABLE_4KHDHUB_URL_VALIDATION is false
        let validatedLinks = uniqueLinks;
        const disableValidation = process.env.DISABLE_4KHDHUB_URL_VALIDATION === 'true';
        
        if (!disableValidation) {
            console.log(`[4KHDHub] URL validation enabled, validating ${uniqueLinks.length} links...`);
            const validationPromises = uniqueLinks.map(async (link) => {
                const isValid = await validateUrl(link.url);
                return isValid ? link : null;
            });
            
            const validationResults = await Promise.all(validationPromises);
            validatedLinks = validationResults.filter(link => link !== null);
            
            console.log(`[4KHDHub] URL validation complete: ${validatedLinks.length}/${uniqueLinks.length} links are valid`);
        } else {
            console.log(`[4KHDHub] URL validation disabled, skipping validation`);
        }
        
        // Convert to Stremio format
        const streams = validatedLinks.map(link => ({
            name: link.name, // Don't add prefix since it's already included
            title: link.title || link.name,
            url: link.url,
            quality: `${link.quality}p`,
            behaviorHints: {
                bingeGroup: '4khdhub-streams'
            }
        }));
        
        console.log(`[4KHDHub] Returning ${streams.length} streams`);
        return streams;
        
    } catch (error) {
        console.error(`[4KHDHub] Error getting streams:`, error.message);
        return [];
    }
}

module.exports = {
    get4KHDHubStreams
};