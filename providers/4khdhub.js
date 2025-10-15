const https = require('https');
const http = require('http');
const { URL } = require('url');
const cheerio = require('cheerio');
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

            // Handle redirects (follow up to 5 redirects)
            if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location) {
                const redirectUrl = res.headers.location.startsWith('http') ? res.headers.location : `${urlObj.protocol}//${urlObj.host}${res.headers.location}`;
                console.log(`[makeRequest] Following redirect: ${url} -> ${redirectUrl}`);

                // Prevent infinite redirect loops
                if (!options._redirectCount) options._redirectCount = 0;
                options._redirectCount++;

                if (options._redirectCount > 5) {
                    reject(new Error(`Too many redirects for ${url}`));
                    return;
                }

                // Follow the redirect
                makeRequest(redirectUrl, { ...options, _redirectCount: options._redirectCount })
                    .then(resolve)
                    .catch(reject);
                return;
            }

            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (options.parseHTML) {
                    try {
                        const $ = cheerio.load(data || '');
                        resolve({ $: $, body: data, statusCode: res.statusCode, headers: res.headers });
                    } catch (error) {
                        console.error(`[makeRequest] Failed to parse HTML for ${url}:`, error.message);
                        reject(new Error(`HTML parsing failed: ${error.message}`));
                    }
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

// Enhanced title normalization with better handling of special cases
function normalizeTitle(title) {
    return title
        .toLowerCase()
        // Handle common title variations
        .replace(/&/g, 'and')           // & -> and
        .replace(/\b(the|a|an)\b/g, '') // Remove articles
        // Handle common abbreviations and expansions
        .replace(/\bvs\b/g, 'versus')
        .replace(/\bversus\b/g, 'vs')
        .replace(/\bdr\b/g, 'doctor')
        .replace(/\bdoctor\b/g, 'dr')
        .replace(/\bmr\b/g, 'mister')
        .replace(/\bmister\b/g, 'mr')
        .replace(/\bst\b/g, 'saint')
        .replace(/\bsaint\b/g, 'st')
        .replace(/\bmt\b/g, 'mount')
        .replace(/\bmount\b/g, 'mt')
        .replace(/[^a-z0-9\s]/g, ' ')   // Remove special characters
        .replace(/\s+/g, ' ')           // Normalize whitespace
        .trim();
}

// Extract year from title if present
function extractYear(title) {
    const yearMatch = title.match(/\((19|20)\d{2}\)/);
    return yearMatch ? parseInt(yearMatch[0].replace(/[()]/g, '')) : null;
}

// Remove year from title for cleaner comparison
function removeYear(title) {
    return title.replace(/\s*\((19|20)\d{2}\)\s*/g, ' ').trim();
}

// Generate alternative search queries for better matching
function generateAlternativeQueries(title, originalTitle = null) {
    const queries = new Set();
    
    // Add the original title
    queries.add(title);
    
    // Add original title if different
    if (originalTitle && originalTitle !== title) {
        queries.add(originalTitle);
    }
    
    // Remove year and try again
    const titleWithoutYear = removeYear(title);
    if (titleWithoutYear !== title) {
        queries.add(titleWithoutYear);
    }
    
    // Remove colons and other punctuation
    queries.add(title.replace(/:/g, ''));
    queries.add(title.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim());
    
    // Handle common title variations
    const variations = [
        title.replace(/\bPart\s+(\d+)\b/gi, 'Part $1'),
        title.replace(/\bPart\s+(\d+)\b/gi, '$1'),
        title.replace(/\b(\d+)\b/g, match => {
            const num = parseInt(match);
            const romans = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
            return romans[num] || match;
        }),
        title.replace(/\b(I{1,3}|IV|V|VI{0,3}|IX|X)\b/g, match => {
            const romans = { 'I': '1', 'II': '2', 'III': '3', 'IV': '4', 'V': '5', 
                           'VI': '6', 'VII': '7', 'VIII': '8', 'IX': '9', 'X': '10' };
            return romans[match] || match;
        })
    ];
    
    variations.forEach(v => {
        if (v && v !== title) queries.add(v);
    });
    
    // Remove duplicates and filter out empty strings
    return Array.from(queries).filter(q => q && q.trim().length > 0);
}

// Enhanced similarity calculation with multiple algorithms
function calculateSimilarity(str1, str2) {
    const s1 = normalizeTitle(str1);
    const s2 = normalizeTitle(str2);
    
    if (s1 === s2) return 1.0;
    
    // Levenshtein distance
    const levenshtein = calculateLevenshteinSimilarity(s1, s2);
    
    // Jaccard similarity (word-based)
    const jaccard = calculateJaccardSimilarity(s1, s2);
    
    // Longest common subsequence
    const lcs = calculateLCSSimilarity(s1, s2);
    
    // Weighted combination of different similarity measures
    return (levenshtein * 0.4) + (jaccard * 0.4) + (lcs * 0.2);
}

// Levenshtein distance similarity
function calculateLevenshteinSimilarity(s1, s2) {
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

// Jaccard similarity for word-based comparison
function calculateJaccardSimilarity(s1, s2) {
    const words1 = new Set(s1.split(' ').filter(w => w.length > 0));
    const words2 = new Set(s2.split(' ').filter(w => w.length > 0));
    
    const intersection = new Set([...words1].filter(w => words2.has(w)));
    const union = new Set([...words1, ...words2]);
    
    return union.size === 0 ? 0 : intersection.size / union.size;
}

// Longest Common Subsequence similarity
function calculateLCSSimilarity(s1, s2) {
    const len1 = s1.length;
    const len2 = s2.length;
    
    if (len1 === 0 || len2 === 0) return 0;
    
    const dp = Array(len1 + 1).fill().map(() => Array(len2 + 1).fill(0));
    
    for (let i = 1; i <= len1; i++) {
        for (let j = 1; j <= len2; j++) {
            if (s1[i - 1] === s2[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }
    
    const maxLen = Math.max(len1, len2);
    return dp[len1][len2] / maxLen;
}

// Enhanced word containment check with fuzzy matching
function containsWords(title, query) {
    const titleWords = normalizeTitle(title).split(' ').filter(w => w.length > 1);
    const queryWords = normalizeTitle(query).split(' ').filter(w => w.length > 1);
    
    let matchedWords = 0;
    
    for (const queryWord of queryWords) {
        const found = titleWords.some(titleWord => {
            // Exact match
            if (titleWord === queryWord) return true;
            
            // Substring match
            if (titleWord.includes(queryWord) || queryWord.includes(titleWord)) return true;
            
            // Fuzzy match for longer words (allow 1 character difference)
            if (queryWord.length > 3 && titleWord.length > 3) {
                const similarity = calculateLevenshteinSimilarity(titleWord, queryWord);
                return similarity > 0.8;
            }
            
            return false;
        });
        
        if (found) matchedWords++;
    }
    
    // Require at least 70% of query words to be matched
    return matchedWords / queryWords.length >= 0.7;
}

// Enhanced best match finder with improved scoring
function findBestMatch(results, query, tmdbYear = null) {
    if (results.length === 0) return null;
    if (results.length === 1) return results[0];
    
    console.log(`[4KHDHub] Finding best match for: "${query}" (Year: ${tmdbYear || 'N/A'})`);
    
    // Strict year gating: if TMDB year is known, only consider exact matches first,
    // then allow unknown-year entries as fallback. Reject clear mismatches.
    let candidateResults = results;
    if (tmdbYear) {
        const tmdbYearInt = parseInt(tmdbYear);
        const exactYearMatches = results.filter(r => {
            const y = r.year || extractYear(r.title);
            return y && parseInt(y) === tmdbYearInt;
        });
        if (exactYearMatches.length > 0) {
            candidateResults = exactYearMatches;
            console.log(`[4KHDHub] Year filter: using ${exactYearMatches.length} exact year matches for ${tmdbYearInt}`);
        } else {
            const unknownYear = results.filter(r => {
                const y = r.year || extractYear(r.title);
                return !y;
            });
            if (unknownYear.length > 0) {
                candidateResults = unknownYear;
                console.log(`[4KHDHub] Year filter: no exact matches; falling back to ${unknownYear.length} unknown-year results`);
            } else {
                console.log(`[4KHDHub] Year filter: no exact or unknown-year matches for ${tmdbYearInt}; rejecting results`);
                return null;
            }
        }
    }
    
    // Score each result
    const scoredResults = candidateResults.map(result => {
        let score = 0;
        // Use year from search result metadata if available, otherwise extract from title
        const resultYear = result.year || extractYear(result.title);
        const queryWithoutYear = removeYear(query);
        const resultWithoutYear = removeYear(result.title);
        
        // Exact match gets highest score (without year)
        if (normalizeTitle(resultWithoutYear) === normalizeTitle(queryWithoutYear)) {
            score += 100;
        }
        
        // Enhanced similarity score (0-60 points)
        const similarity = calculateSimilarity(resultWithoutYear, queryWithoutYear);
        score += similarity * 60;
        
        // Word containment bonus (0-25 points)
        if (containsWords(result.title, query)) {
            score += 25;
        }
        
        // Year matching bonus (strict): only reward exact match when TMDB year is known
        if (tmdbYear && resultYear) {
            if (parseInt(tmdbYear) === parseInt(resultYear)) {
                score += 30; // Strong reward for exact year
            }
        } else if (resultYear && !tmdbYear) {
            score += 5; // Slight bonus for having year info when TMDB year unknown
        }
        
        // Length similarity bonus (0-10 points)
        const lengthDiff = Math.abs(resultWithoutYear.length - queryWithoutYear.length);
        score += Math.max(0, 10 - lengthDiff / 3);
        
        // Prefer results with quality indicators
        if (result.title.match(/\b(1080p|720p|4K|2160p|BluRay|WEB-DL)\b/i)) {
            score += 3;
        }
        
        // Penalty for results with too many extra words
        const queryWordCount = queryWithoutYear.split(' ').filter(w => w.length > 0).length;
        const resultWordCount = resultWithoutYear.split(' ').filter(w => w.length > 0).length;
        if (resultWordCount > queryWordCount * 2) {
            score -= 10;
        }
        
        return { ...result, score, similarity, resultYear };
    });
    
    // Sort by score (highest first)
    scoredResults.sort((a, b) => b.score - a.score);
    
    console.log('[4KHDHub] Title matching scores:');
    scoredResults.slice(0, 5).forEach((result, index) => {
        console.log(`${index + 1}. ${result.title} (Score: ${result.score.toFixed(1)}, Similarity: ${(result.similarity * 100).toFixed(1)}%, Year: ${result.resultYear || 'N/A'})`);
    });
    
    // Additional validation: ensure the best match has a reasonable score
    const bestResult = scoredResults[0];
    // Final guard: if TMDB year is known and best has a conflicting year, reject
    if (tmdbYear && bestResult.resultYear && parseInt(bestResult.resultYear) !== parseInt(tmdbYear)) {
        console.log(`[4KHDHub] Best match year mismatch (best=${bestResult.resultYear}, tmdb=${tmdbYear}), rejecting`);
        return null;
    }
    if (bestResult.score < 30) {
        console.log(`[4KHDHub] Best match score too low (${bestResult.score.toFixed(1)}), rejecting`);
        return null;
    }
    
    return bestResult;
}

function extractHubCloudLinks(url, referer) {
    console.log(`[4KHDHub] Starting HubCloud extraction for: ${url}`);
    const baseUrl = getBaseUrl(url);

    return makeRequest(url, { parseHTML: true })
        .then(response => {
            if (!response || !response.$) {
                throw new Error(`Invalid response from HubCloud URL: ${url}`);
            }
            const $ = response.$;
            console.log(`[4KHDHub] Got HubCloud page, looking for download element...`);
            
            // Check if this is already a hubcloud.php URL
            let href;
            if (url.includes('hubcloud.php')) {
                href = url;
                console.log(`[4KHDHub] Already a hubcloud.php URL: ${href}`);
            } else {
                const downloadElement = $('#download');
                if (downloadElement.length === 0) {
                    console.log('[4KHDHub] Download element #download not found, trying alternatives...');
                    // Try alternative selectors
                    const alternatives = ['a[href*="hubcloud.php"]', '.download-btn', 'a[href*="download"]'];
                    let found = false;
                    
                    for (const selector of alternatives) {
                        const altElement = $(selector).first();
                        if (altElement.length > 0) {
                            const rawHref = altElement.attr('href');
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
                    const rawHref = downloadElement.attr('href');
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
            const $ = response.$;
            const results = [];
            
            console.log(`[4KHDHub] Processing HubCloud download page...`);
            
            // Extract quality and size information
            const size = $('i#size').text() || '';
            const header = $('div.card-header').text() || '';
            const quality = getIndexQuality(header);
            const headerDetails = cleanTitle(header);
            
            console.log(`[4KHDHub] Extracted info - Size: ${size}, Header: ${header}, Quality: ${quality}, HeaderDetails: ${headerDetails}`);
            
            // Extract just the quality for clean naming
            const qualityLabel = quality ? ` - ${quality}p` : '';
            
            // We'll build the title format later after getting actual filename from HEAD request
            
            // Find download buttons
            const downloadButtons = $('div.card-body h2 a.btn');
            console.log(`[4KHDHub] Found ${downloadButtons.length} download buttons`);
            
            if (downloadButtons.length === 0) {
                // Try alternative selectors for download buttons
                const altSelectors = ['a.btn', '.btn', 'a[href]'];
                for (const selector of altSelectors) {
                    const altButtons = $(selector);
                    if (altButtons.length > 0) {
                        console.log(`[4KHDHub] Found ${altButtons.length} buttons with alternative selector: ${selector}`);
                        altButtons.each((index, btn) => {
                            const $btn = $(btn);
                            const link = $btn.attr('href');
                            const text = $btn.text();
                            console.log(`[4KHDHub] Button ${index + 1}: ${text} -> ${link}`);
                        });
                        break;
                    }
                }
            }
            
            const promises = downloadButtons.get().map((button, index) => {
                return new Promise((resolve) => {
                    const $button = $(button);
                    const link = $button.attr('href');
                    const text = $button.text();
                    
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
            const $ = response.$;
            const results = [];
            
            $('div.card-grid a').each((index, card) => {
                const $card = $(card);
                const title = $card.find('h3').text();
                const href = $card.attr('href');
                const posterUrl = $card.find('img').attr('src');
                
                // Extract year from movie-card-meta element
                const metaElement = $card.find('.movie-card-meta');
                let year = null;
                if (metaElement.length > 0) {
                    const metaText = metaElement.text().trim();
                    const yearMatch = metaText.match(/(19|20)\d{2}/);
                    if (yearMatch) {
                        year = parseInt(yearMatch[0]);
                    }
                }
                
                if (title && href) {
                    // Convert relative URLs to absolute URLs
                    const absoluteUrl = href.startsWith('http') ? href : `${baseUrl}${href.startsWith('/') ? '' : '/'}${href}`;
                    results.push({
                        title: title.trim(),
                        url: absoluteUrl,
                        poster: posterUrl || '',
                        year: year
                    });
                }
            });
            
            return results;
        });
}

function loadContent(url) {
    return makeRequest(url, { parseHTML: true })
        .then(response => {
            const $ = response.$;
            const title = $('h1.page-title').text().split('(')[0].trim() || '';
            const poster = $('meta[property="og:image"]').attr('content') || '';
            const tags = $('div.mt-2 span.badge').map((i, el) => $(el).text()).get();
            const year = parseInt($('div.mt-2 span').text()) || null;
            const description = $('div.content-section p.mt-4').text().trim() || '';
            const trailer = $('#trailer-btn').attr('data-trailer-url') || '';
            
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
                const links = $(selector)
                    .map((i, a) => $(a).attr('href'))
                    .get()
                    .filter(href => href && href.trim());
                if (links.length > 0) {
                    hrefs = links;
                    console.log(`[4KHDHub] Found ${links.length} links using selector: ${selector}`);
                    break;
                }
            }
            
            if (hrefs.length === 0) {
                console.log('[4KHDHub] No download links found. Available links on page:');
                const allLinks = $('a[href]')
                    .map((i, a) => $(a).attr('href'))
                    .get()
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
                const seasonItems = $('div.episodes-list div.season-item');
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
                        const items = $(selector);
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
                    seasonItems.each((i, seasonElement) => {
                        const $seasonElement = $(seasonElement);
                        const seasonText = $seasonElement.find('div.episode-number').text() || '';
                        const seasonMatch = seasonText.match(/S?([1-9][0-9]*)/); 
                        const season = seasonMatch ? parseInt(seasonMatch[1]) : null;
                        
                        const episodeItems = $seasonElement.find('div.episode-download-item');
                        episodeItems.each((j, episodeItem) => {
                            const $episodeItem = $(episodeItem);
                            const episodeText = $episodeItem.find('div.episode-file-info span.badge-psa').text() || '';
                            const episodeMatch = episodeText.match(/Episode-0*([1-9][0-9]*)/); 
                            const episode = episodeMatch ? parseInt(episodeMatch[1]) : null;
                            
                            const episodeHrefs = $episodeItem.find('a')
                                .map((k, a) => $(a).attr('href'))
                                .get()
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
            if (!response || !response.$) {
                throw new Error(`Invalid response from HubDrive URL: ${url}`);
            }
            const $ = response.$;

            console.log(`[4KHDHub] Got HubDrive page, looking for download button...`);
            
            // Extract filename and size information
            const size = $('i#size').text() || '';
            const header = $('div.card-header').text() || '';
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
            const downloadBtn = $('.btn.btn-primary.btn-user.btn-success1.m-1').first();
            
            if (downloadBtn.length === 0) {
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
                    foundBtn = $(selector).first();
                    if (foundBtn.length > 0) {
                        console.log(`[4KHDHub] Found download button with selector: ${selector}`);
                        break;
                    }
                }
                
                if (!foundBtn || foundBtn.length === 0) {
                    throw new Error('Download button not found with any selector');
                }
                
                const href = foundBtn.attr('href');
                if (!href) {
                    throw new Error('Download link not found');
                }
                
                console.log(`[4KHDHub] Found HubDrive download link: ${href}`);
                return processHubDriveLink(href, referer, filename, size, quality);
            }
            
            const href = downloadBtn.attr('href');
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
        const cacheKey = `4khdhub_resolved_urls_v5_${tmdbId}_${type}${season ? `_s${season}e${episode}` : ''}`;
        
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
            
            // Enhanced search with fallback strategies
            let searchResults = [];
            let bestMatch = null;
            
            // Primary search using the actual title
            const searchQuery = tmdbDetails.title;
            searchResults = await searchContent(searchQuery);
            console.log(`[4KHDHub] Primary search found ${searchResults.length} results`);
            
            if (searchResults.length > 0) {
                bestMatch = findBestMatch(searchResults, tmdbDetails.title, tmdbDetails.year);
            }
            
            // Fallback search strategies if no good match found
            if (!bestMatch && searchResults.length > 0) {
                console.log(`[4KHDHub] No good match from primary search, trying fallback strategies...`);
                
                // Try search without year
                const titleWithoutYear = removeYear(tmdbDetails.title);
                if (titleWithoutYear !== tmdbDetails.title) {
                    console.log(`[4KHDHub] Trying search without year: "${titleWithoutYear}"`);
                    const fallbackResults = await searchContent(titleWithoutYear);
                    if (fallbackResults.length > 0) {
                        const fallbackMatch = findBestMatch(fallbackResults, tmdbDetails.title, tmdbDetails.year);
                        if (fallbackMatch && (!bestMatch || fallbackMatch.score > bestMatch.score)) {
                            bestMatch = fallbackMatch;
                            searchResults = fallbackResults;
                        }
                    }
                }
                
                // Try search with comprehensive alternative title formats
                if (!bestMatch) {
                    const alternativeQueries = generateAlternativeQueries(
                        tmdbDetails.title, 
                        tmdbDetails.original_title
                    ).filter(query => query !== tmdbDetails.title); // Exclude the original title we already tried
                    
                    for (const altQuery of alternativeQueries) {
                        console.log(`[4KHDHub] Trying alternative search: "${altQuery}"`);
                        const altResults = await searchContent(altQuery);
                        if (altResults.length > 0) {
                            const altMatch = findBestMatch(altResults, tmdbDetails.title, tmdbDetails.year);
                            if (altMatch && (!bestMatch || altMatch.score > bestMatch.score)) {
                                bestMatch = altMatch;
                                searchResults = altResults;
                                console.log(`[4KHDHub] Found better match with query: "${altQuery}" (score: ${altMatch.score})`);
                                break;
                            }
                        }
                    }
                }
            }
            
            if (searchResults.length === 0) {
                console.log(`[4KHDHub] No search results found for any query variation`);
                return [];
            }
            
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