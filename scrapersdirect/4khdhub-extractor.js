#!/usr/bin/env node

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { JSDOM } = require('jsdom');

// Configuration
const DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
let cachedDomains = null;

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

function makeRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const protocol = urlObj.protocol === 'https:' ? https : http;
        
        const requestOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port,
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                ...options.headers
            }
        };

        if (options.allowRedirects === false) {
            requestOptions.followRedirect = false;
        }

        const req = protocol.request(requestOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: data,
                    document: options.parseHTML ? new JSDOM(data).window.document : null
                });
            });
        });

        req.on('error', reject);
        req.end();
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
            console.error('Failed to fetch domains:', error.message);
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
                console.error('Error processing links:', e.message);
                return Promise.resolve('');
            }
        })
        .catch(error => {
            console.error('Error fetching redirect links:', error.message);
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
    const parts = title.split(/[.\-_]/);
    
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
    
    console.log('\nTitle matching scores:');
    scoredResults.slice(0, 5).forEach((result, index) => {
        console.log(`${index + 1}. ${result.title} (Score: ${result.score.toFixed(1)})`);
    });
    
    return scoredResults[0];
}

function extractHubCloudLinks(url, referer) {
    console.log(`Starting HubCloud extraction for: ${url}`);
    const baseUrl = getBaseUrl(url);
    
    return makeRequest(url, { parseHTML: true })
        .then(response => {
            const document = response.document;
            console.log(`Got HubCloud page, looking for download element...`);
            
            // Check if this is already a hubcloud.php URL
            let href;
            if (url.includes('hubcloud.php')) {
                href = url;
                console.log(`Already a hubcloud.php URL: ${href}`);
            } else {
                const downloadElement = document.querySelector('#download');
                if (!downloadElement) {
                    console.log('Download element #download not found, trying alternatives...');
                    // Try alternative selectors
                    const alternatives = ['a[href*="hubcloud.php"]', '.download-btn', 'a[href*="download"]'];
                    let found = false;
                    
                    for (const selector of alternatives) {
                        const altElement = document.querySelector(selector);
                        if (altElement) {
                            const rawHref = altElement.getAttribute('href');
                            if (rawHref) {
                                href = rawHref.startsWith('http') ? rawHref : `${baseUrl.replace(/\/$/, '')}/${rawHref.replace(/^\//, '')}`;
                                console.log(`Found download link with selector ${selector}: ${href}`);
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
                    console.log(`Found download href: ${href}`);
                }
            }
            
            console.log(`Making request to HubCloud download page: ${href}`);
            return makeRequest(href, { parseHTML: true });
        })
        .then(response => {
            const document = response.document;
            const results = [];
            
            console.log(`Processing HubCloud download page...`);
            
            // Extract quality and size information
            const size = document.querySelector('i#size')?.textContent || '';
            const header = document.querySelector('div.card-header')?.textContent || '';
            const quality = getIndexQuality(header);
            const headerDetails = cleanTitle(header);
            
            console.log(`Extracted info - Size: ${size}, Header: ${header}, Quality: ${quality}`);
            
            const labelExtras = [];
            if (headerDetails) labelExtras.push(`[${headerDetails}]`);
            if (size) labelExtras.push(`[${size}]`);
            const labelExtra = labelExtras.join('');
            
            // Find download buttons
            const downloadButtons = document.querySelectorAll('div.card-body h2 a.btn');
            console.log(`Found ${downloadButtons.length} download buttons`);
            
            if (downloadButtons.length === 0) {
                // Try alternative selectors for download buttons
                const altSelectors = ['a.btn', '.btn', 'a[href]'];
                for (const selector of altSelectors) {
                    const altButtons = document.querySelectorAll(selector);
                    if (altButtons.length > 0) {
                        console.log(`Found ${altButtons.length} buttons with alternative selector: ${selector}`);
                        altButtons.forEach((btn, index) => {
                            const link = btn.getAttribute('href');
                            const text = btn.textContent;
                            console.log(`Button ${index + 1}: ${text} -> ${link}`);
                        });
                        break;
                    }
                }
            }
            
            const promises = Array.from(downloadButtons).map((button, index) => {
                return new Promise((resolve) => {
                    const link = button.getAttribute('href');
                    const text = button.textContent;
                    
                    console.log(`Processing button ${index + 1}: "${text}" -> ${link}`);
                    
                    if (!link) {
                        console.log(`Button ${index + 1} has no link`);
                        resolve(null);
                        return;
                    }
                    
                    const buttonBaseUrl = getBaseUrl(link);
                    
                    if (text.includes('FSL Server')) {
                        console.log(`Button ${index + 1} is FSL Server`);
                        resolve({
                            name: `${referer} [FSL Server] ${labelExtra}`,
                            url: link,
                            quality: quality
                        });
                    } else if (text.includes('Download File')) {
                        console.log(`Button ${index + 1} is Download File`);
                        resolve({
                            name: `${referer} ${labelExtra}`,
                            url: link,
                            quality: quality
                        });
                    } else if (text.includes('BuzzServer')) {
                        console.log(`Button ${index + 1} is BuzzServer, following redirect...`);
                        // Handle BuzzServer redirect
                        makeRequest(`${link}/download`, { 
                            parseHTML: false,
                            allowRedirects: false,
                            headers: { 'Referer': link }
                        })
                        .then(response => {
                            const redirectUrl = response.headers['hx-redirect'] || response.headers['location'];
                            if (redirectUrl) {
                                console.log(`BuzzServer redirect found: ${redirectUrl}`);
                                resolve({
                                    name: `${referer} [BuzzServer] ${labelExtra}`,
                                    url: buttonBaseUrl + redirectUrl,
                                    quality: quality
                                });
                            } else {
                                console.log(`BuzzServer redirect not found`);
                                resolve(null);
                            }
                        })
                        .catch(err => {
                            console.log(`BuzzServer redirect failed: ${err.message}`);
                            resolve(null);
                        });
                    } else if (link.includes('pixeldra')) {
                        console.log(`Button ${index + 1} is Pixeldrain`);
                        resolve({
                            name: `Pixeldrain ${labelExtra}`,
                            url: link,
                            quality: quality
                        });
                    } else if (text.includes('S3 Server')) {
                        console.log(`Button ${index + 1} is S3 Server`);
                        resolve({
                            name: `${referer} S3 Server ${labelExtra}`,
                            url: link,
                            quality: quality
                        });
                    } else if (text.includes('10Gbps')) {
                        console.log(`Button ${index + 1} is 10Gbps server, following redirects...`);
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
                                
                                console.log(`10Gbps redirect: ${redirectUrl}`);
                                
                                if (redirectUrl.includes('id=')) {
                                    // Final redirect, extract the link parameter
                                    const finalLink = redirectUrl.split('link=')[1];
                                    if (finalLink) {
                                        console.log(`10Gbps final link: ${finalLink}`);
                                        return {
                                            name: `${referer} [Download] ${labelExtra}`,
                                            url: decodeURIComponent(finalLink),
                                            quality: quality
                                        };
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
                                console.log(`10Gbps processing completed`);
                                resolve(result);
                            })
                            .catch(err => {
                                console.log(`10Gbps processing failed: ${err.message}`);
                                resolve(null);
                            });
                    } else {
                        console.log(`Button ${index + 1} is generic link`);
                        // Generic link
                        resolve({
                            name: `${referer} ${labelExtra}`,
                            url: link,
                            quality: quality
                        });
                    }
                });
            });
            
            return Promise.all(promises)
                .then(results => {
                    const validResults = results.filter(result => result !== null);
                    console.log(`HubCloud extraction completed, found ${validResults.length} valid links`);
                    return validResults;
                });
        })
        .catch(error => {
            console.error(`HubCloud extraction error for ${url}:`, error.message);
            return [];
        });
}

function extractHubDriveLinks(url) {
    return makeRequest(url, { parseHTML: true })
        .then(response => {
            const document = response.document;
            
            // Use the exact selector from Kotlin code
            const downloadBtn = document.querySelector('.btn.btn-primary.btn-user.btn-success1.m-1');
            
            if (!downloadBtn) {
                console.log('Primary download button not found, trying alternative selectors...');
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
                        console.log(`Found download button with selector: ${selector}`);
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
                
                return processHubDriveLink(href);
            }
            
            const href = downloadBtn.getAttribute('href');
            if (!href) {
                throw new Error('Download link not found');
            }
            
            return processHubDriveLink(href);
        })
        .catch(error => {
            console.error('Error extracting HubDrive links:', error.message);
            return [];
        });
}

function processHubDriveLink(href) {
    // Check if it's a HubCloud link
    if (href.toLowerCase().includes('hubcloud')) {
        console.log('HubDrive link redirects to HubCloud, processing...');
        return extractHubCloudLinks(href, 'HubDrive');
    } else {
        console.log('HubDrive direct link found');
        // Direct link or other extractor
        return Promise.resolve([{
            name: 'HubDrive',
            url: href,
            quality: 1080
        }]);
    }
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
                    console.log(`Found ${links.length} links using selector: ${selector}`);
                    break;
                }
            }
            
            if (hrefs.length === 0) {
                console.log('No download links found. Available links on page:');
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
                
                const seasonItems = document.querySelectorAll('div.episodes-list div.season-item');
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
                
                return Promise.resolve(content);
            }
        });
}

function extractStreamingLinks(downloadLinks) {
    console.log(`Processing ${downloadLinks.length} download links...`);
    
    // Log the actual links being processed
    downloadLinks.forEach((link, index) => {
        console.log(`Link ${index + 1}: ${link}`);
    });
    
    const promises = downloadLinks.map((link, index) => {
        return new Promise((resolve) => {
            console.log(`Processing link ${index + 1}: ${link}`);
            
            // Check if link needs redirect processing
            if (link.toLowerCase().includes('id=')) {
                console.log(`Link ${index + 1} needs redirect processing`);
                getRedirectLinks(link)
                    .then(resolvedLink => {
                        if (resolvedLink) {
                            console.log(`Link ${index + 1} resolved to: ${resolvedLink}`);
                            processExtractorLink(resolvedLink, resolve, index + 1);
                        } else {
                            console.log(`Link ${index + 1} redirect resolution failed`);
                            resolve(null);
                        }
                    })
                    .catch(err => {
                        console.error(`Redirect failed for link ${index + 1} (${link}):`, err.message);
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
            console.log(`Successfully extracted ${filteredResults.length} streaming links (${flatResults.length - filteredResults.length} .zip files excluded)`);
            return filteredResults;
        });
}

function processExtractorLink(link, resolve, linkNumber) {
    const linkLower = link.toLowerCase();
    
    console.log(`Checking extractors for link ${linkNumber}: ${link}`);
    
    if (linkLower.includes('hubdrive')) {
        console.log(`Link ${linkNumber} matched HubDrive extractor`);
        extractHubDriveLinks(link)
            .then(links => {
                console.log(`HubDrive extraction completed for link ${linkNumber}:`, links);
                resolve(links);
            })
            .catch(err => {
                console.error(`HubDrive extraction failed for link ${linkNumber} (${link}):`, err.message);
                resolve(null);
            });
    } else if (linkLower.includes('hubcloud')) {
        console.log(`Link ${linkNumber} matched HubCloud extractor`);
        extractHubCloudLinks(link, 'HubCloud')
            .then(links => {
                console.log(`HubCloud extraction completed for link ${linkNumber}:`, links);
                resolve(links);
            })
            .catch(err => {
                console.error(`HubCloud extraction failed for link ${linkNumber} (${link}):`, err.message);
                resolve(null);
            });
    } else {
        console.log(`No extractor matched for link ${linkNumber}: ${link}`);
        // Try to extract any direct streaming URLs from the link
        if (link.includes('http') && (link.includes('.mp4') || link.includes('.mkv') || link.includes('.avi'))) {
            console.log(`Link ${linkNumber} appears to be a direct video link`);
            resolve([{
                name: 'Direct Link',
                url: link,
                quality: 1080
            }]);
        } else {
            resolve(null);
        }
    }
}

// Main function
function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log('Usage: node 4khdhub-extractor.js <search_query> [season_number] [episode_number]');
        console.log('Examples:');
        console.log('  node 4khdhub-extractor.js "Avengers Endgame"');
        console.log('  node 4khdhub-extractor.js "Breaking Bad" 1');
        console.log('  node 4khdhub-extractor.js "Breaking Bad" 3 7');
        process.exit(1);
    }
    
    const query = args[0];
    const seasonNumber = args[1] ? parseInt(args[1]) : null;
    const episodeNumber = args[2] ? parseInt(args[2]) : (args[1] && !args[2] ? parseInt(args[1]) : null);
    
    console.log(`Searching for: ${query}`);
    
    searchContent(query)
        .then(results => {
            if (results.length === 0) {
                console.log('No results found.');
                return;
            }
            
            console.log(`Found ${results.length} result(s):`);
            results.forEach((result, index) => {
                console.log(`${index + 1}. ${result.title}`);
            });
            
            // Find the best matching result
            const selectedResult = findBestMatch(results, query);
            if (!selectedResult) {
                console.log('No suitable match found.');
                return;
            }
            console.log(`\nSelected best match: ${selectedResult.title}`);
            console.log(`Loading content: ${selectedResult.title}`);
            
            return loadContent(selectedResult.url);
        })
        .then(content => {
            if (!content) return;
            
            console.log(`\nTitle: ${content.title}`);
            console.log(`Type: ${content.type}`);
            console.log(`Year: ${content.year || 'Unknown'}`);
            console.log(`Description: ${content.description || 'No description'}`);
            
            if (content.type === 'movie') {
                console.log('\nExtracting streaming links...');
                return extractStreamingLinks(content.downloadLinks)
                    .then(links => {
                        // Sort links by size first, then by resolution
                        links.sort((a, b) => {
                            // Extract size from name (e.g., "[3.75 GB]", "[63 GB]")
                            const getSizeInGB = (name) => {
                                const sizeMatch = name.match(/\[(\d+(?:\.\d+)?)\s*GB\]/i);
                                if (sizeMatch) {
                                    return parseFloat(sizeMatch[1]);
                                }
                                const sizeMBMatch = name.match(/\[(\d+(?:\.\d+)?)\s*MB\]/i);
                                if (sizeMBMatch) {
                                    return parseFloat(sizeMBMatch[1]) / 1024; // Convert MB to GB
                                }
                                return 0; // No size found, put at beginning
                            };
                            
                            const sizeA = getSizeInGB(a.name);
                            const sizeB = getSizeInGB(b.name);
                            
                            // First sort by size (descending - larger files first)
                             if (sizeA !== sizeB) {
                                 return sizeB - sizeA;
                             }
                            
                            // If sizes are equal, sort by resolution (descending - higher quality first)
                            const qualityA = parseInt(a.quality) || 0;
                            const qualityB = parseInt(b.quality) || 0;
                            return qualityB - qualityA;
                        });
                        
                        console.log(`\nFound ${links.length} streaming link(s) (sorted by size, then resolution):`);
                        links.forEach((link, index) => {
                            console.log(`${index + 1}. ${link.name} (${link.quality || 'Unknown'}p)`);
                            console.log(`   URL: ${link.url}`);
                        });
                    });
            } else {
                if (episodeNumber) {
                    let episode;
                    if (seasonNumber && episodeNumber) {
                        episode = content.episodes.find(ep => ep.season === seasonNumber && ep.episode === episodeNumber);
                        console.log(`\nExtracting links for Season ${seasonNumber} Episode ${episodeNumber}...`);
                    } else {
                        episode = content.episodes.find(ep => ep.episode === episodeNumber);
                        console.log(`\nExtracting links for Episode ${episodeNumber}...`);
                    }
                    if (episode) {
                        return extractStreamingLinks(episode.downloadLinks)
                            .then(links => {
                                // Sort links by size first, then by resolution
                                links.sort((a, b) => {
                                    // Extract size from name (e.g., "[3.75 GB]", "[63 GB]")
                                    const getSizeInGB = (name) => {
                                        const sizeMatch = name.match(/\[(\d+(?:\.\d+)?)\s*GB\]/i);
                                        if (sizeMatch) {
                                            return parseFloat(sizeMatch[1]);
                                        }
                                        const sizeMBMatch = name.match(/\[(\d+(?:\.\d+)?)\s*MB\]/i);
                                        if (sizeMBMatch) {
                                            return parseFloat(sizeMBMatch[1]) / 1024; // Convert MB to GB
                                        }
                                        return 0; // No size found, put at beginning
                                    };
                                    
                                    const sizeA = getSizeInGB(a.name);
                                    const sizeB = getSizeInGB(b.name);
                                    
                                    // First sort by size (descending - larger files first)
                                     if (sizeA !== sizeB) {
                                         return sizeB - sizeA;
                                     }
                                    
                                    // If sizes are equal, sort by resolution (descending - higher quality first)
                                    const qualityA = parseInt(a.quality) || 0;
                                    const qualityB = parseInt(b.quality) || 0;
                                    return qualityB - qualityA;
                                });
                                
                                if (seasonNumber && episodeNumber) {
                                    console.log(`\nFound ${links.length} streaming link(s) for Season ${seasonNumber} Episode ${episodeNumber} (sorted by size, then resolution):`);
                                } else {
                                    console.log(`\nFound ${links.length} streaming link(s) for Episode ${episodeNumber} (sorted by size, then resolution):`);
                                }
                                 links.forEach((link, index) => {
                                     console.log(`${index + 1}. ${link.name} (${link.quality || 'Unknown'}p)`);
                                     console.log(`   URL: ${link.url}`);
                                });
                            });
                    } else {
                        if (seasonNumber && episodeNumber) {
                            console.log(`Season ${seasonNumber} Episode ${episodeNumber} not found.`);
                        } else {
                            console.log(`Episode ${episodeNumber} not found.`);
                        }
                    }
                } else {
                    console.log(`\nAvailable episodes:`);
                    content.episodes.forEach(ep => {
                        console.log(`Season ${ep.season}, Episode ${ep.episode}`);
                    });
                    console.log('\nSpecify an episode number to extract links.');
                }
            }
        })
        .catch(error => {
            console.error('Error:', error.message);
            process.exit(1);
        });
}

if (require.main === module) {
    main();
}

module.exports = {
    searchContent,
    loadContent,
    extractStreamingLinks,
    getDomains,
    getRedirectLinks
};