const https = require('https');
const http = require('http');
const { JSDOM } = require('jsdom');

// Suppress JSDOM warnings
const originalConsoleError = console.error;
console.error = function(...args) {
    const message = args.join(' ');
    if (message.includes('Could not parse CSS stylesheet') || 
        message.includes('Error: Could not parse CSS') ||
        message.includes('jsdom/lib/jsdom') ||
        message.includes('parse5')) {
        return; // Suppress CSS and JSDOM parsing warnings
    }
    originalConsoleError.apply(console, args);
};

// Main URL for MoviesDrive
let mainUrl = 'https://moviesdrive.design';
const cinemetaUrl = 'https://v3-cinemeta.strem.io/meta';

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

// Function to search for movies/shows
function searchContent(query, callback) {
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
                    callback(searchResults);
                }
                return;
            }
            
            const dom = new JSDOM(html);
            const document = dom.window.document;
            const movieElements = document.querySelectorAll('ul.recent-movies > li');
            
            if (movieElements.length === 0) {
                callback(searchResults);
                return;
            }
            
            movieElements.forEach(element => {
                const titleElement = element.querySelector('figure > img');
                const linkElement = element.querySelector('figure > a');
                const posterElement = element.querySelector('figure > img');
                
                if (titleElement && linkElement) {
                    const title = titleElement.getAttribute('title');
                    const href = linkElement.getAttribute('href');
                    const posterUrl = posterElement ? posterElement.getAttribute('src') : '';
                    
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
                callback(searchResults);
            }
        });
    }
    
    searchPage(1);
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
        
        const dom = new JSDOM(html);
        const document = dom.window.document;
        
        let link = '';
        if (newUrl.includes('drive')) {
            // Extract from script tag
            const scriptTags = document.querySelectorAll('script');
            for (let script of scriptTags) {
                const scriptContent = script.textContent || '';
                const match = scriptContent.match(/var url = '([^']*)'/); 
                if (match) {
                    link = match[1];
                    break;
                }
            }
        } else {
            // Extract from div.vd > center > a
            const linkElement = document.querySelector('div.vd > center > a');
            if (linkElement) {
                link = linkElement.getAttribute('href') || '';
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
            
            const finalDom = new JSDOM(finalHtml);
            const finalDocument = finalDom.window.document;
            
            const header = finalDocument.querySelector('div.card-header');
            const headerText = header ? header.textContent : '';
            const sizeElement = finalDocument.querySelector('i#size');
            const size = sizeElement ? sizeElement.textContent : '';
            

            
            const downloadButtons = finalDocument.querySelectorAll('div.card-body h2 a.btn');
            const finalLinks = [];
            let processedButtons = 0;
            const totalButtons = downloadButtons.length;
            
            if (totalButtons === 0) {
                callback([]);
                return;
            }
            
            Array.from(downloadButtons).forEach(button => {
                const buttonHref = button.getAttribute('href');
                const buttonText = button.textContent || '';
                
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
                     let finalPixeldrainUrl = buttonHref;
                     if (buttonHref && buttonHref.includes('pixeldrain.net/u/')) {
                         const fileId = buttonHref.split('/u/')[1];
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
            
            const dom = new JSDOM(html);
            const document = dom.window.document;
            
            const fileNameElement = document.querySelector('ul > li.list-group-item');
            let fileName = '';
            let fileSize = '';
            
            const listItems = document.querySelectorAll('ul > li.list-group-item');
            listItems.forEach(item => {
                const text = item.textContent || '';
                if (text.includes('Name :')) {
                    fileName = text.replace('Name :', '').trim();
                } else if (text.includes('Size :')) {
                    fileSize = text.replace('Size :', '').trim();
                }
            });
            

            
            const downloadButtons = document.querySelectorAll('div.text-center a');
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
            
            Array.from(downloadButtons).forEach(button => {
                const buttonHref = button.getAttribute('href');
                const buttonText = button.textContent || '';
                
                if (buttonText.includes('DIRECT DL')) {
                    processButton(buttonHref, 'GDFlix[Direct]');
                } else if (buttonText.includes('CLOUD DOWNLOAD [R2]')) {
                    processButton(buttonHref, 'GDFlix[Cloud Download]');
                } else if (buttonText.includes('PixelDrain DL')) {
                    processButton(buttonHref, 'Pixeldrain');
                } else if (buttonText.includes('Index Links')) {
                    // Handle Index Links - need to fetch and parse the index page
                    makeRequest(latestUrl + buttonHref, (err, indexHtml) => {
                        if (!err && indexHtml) {
                            const indexDom = new JSDOM(indexHtml);
                            const indexDoc = indexDom.window.document;
                            const indexButtons = indexDoc.querySelectorAll('a.btn.btn-outline-info');
                            
                            if (indexButtons.length > 0) {
                                // Process first index button for simplicity
                                const firstIndexButton = indexButtons[0];
                                const serverUrl = latestUrl + firstIndexButton.getAttribute('href');
                                
                                makeRequest(serverUrl, (err2, serverHtml) => {
                                    if (!err2 && serverHtml) {
                                        const serverDom = new JSDOM(serverHtml);
                                        const serverDoc = serverDom.window.document;
                                        const sourceLinks = serverDoc.querySelectorAll('div.mb-4 > a');
                                        
                                        sourceLinks.forEach(sourceAnchor => {
                                            const sourceHref = sourceAnchor.getAttribute('href');
                                            if (sourceHref) {
                                                finalLinks.push({
                                                    url: sourceHref,
                                                    source: 'GDFlix[Index]',
                                                    title: title,
                                                    quality: extractQuality(fileName),
                                                    size: fileSize,
                                                    fileName: fileName
                                                });
                                            }
                                        });
                                    }
                                    processedButtons++;
                                    if (processedButtons === totalButtons) {
                                        callback(finalLinks);
                                    }
                                });
                            } else {
                                processedButtons++;
                                if (processedButtons === totalButtons) {
                                    callback(finalLinks);
                                }
                            }
                        } else {
                            processedButtons++;
                            if (processedButtons === totalButtons) {
                                callback(finalLinks);
                            }
                        }
                    });
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
                    // Skip unknown button types (DRIVEBOT and GoFile are complex, skipping for now)
                    processedButtons++;
                    if (processedButtons === totalButtons) {
                        callback(finalLinks);
                    }
                }
            });
        });
    });
}

// Function to extract quality from filename and return numeric value for sorting
function getIndexQuality(str) {
    if (!str) return 0;
    const match = str.match(/(\d{3,4})[pP]/);
    return match ? parseInt(match[1]) : 0;
}

// Function to extract quality from filename
function extractQuality(str) {
    if (!str) return 'Unknown';
    const match = str.match(/(\d{3,4})[pP]/);
    return match ? match[1] + 'p' : 'Unknown';
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

// Function to extract streaming links from a movie/show page
function extractStreamingLinks(url, callback, episodeInfo = null) {
    makeRequest(url, (err, html) => {
        if (err) {
            console.error('Error fetching movie page:', err.message);
            callback([]);
            return;
        }
        
        const dom = new JSDOM(html);
        const document = dom.window.document;
        
        // Get title and determine if it's a series or movie
        const titleElement = document.querySelector('meta[property="og:title"]');
        const title = titleElement ? titleElement.getAttribute('content').replace('Download ', '') : '';
        
        const seasonRegex = /season\s*\d+/i;
        const isSeriesCheck = title.toLowerCase().includes('episode') || 
                             seasonRegex.test(title) || 
                             title.toLowerCase().includes('series');
        
        // Get download buttons
        const buttons = document.querySelectorAll('h5 > a');
        let downloadLinks = [];
        
        Array.from(buttons).forEach(button => {
            const buttonText = button.textContent || '';
            if (!buttonText.toLowerCase().includes('zip')) {
                const href = button.getAttribute('href');
                if (href) {
                    downloadLinks.push(href);
                }
            }
        });
        
        if (downloadLinks.length === 0) {
            callback([]);
            return;
        }
        
        // Process each download page to extract streaming links
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
                
                const pageDom = new JSDOM(pageHtml);
                const pageDocument = pageDom.window.document;
                
                // Look for streaming links (HubCloud, GDFlix, GDLink)
                const streamingElements = pageDocument.querySelectorAll('a');
                const intermediateLinks = [];
                
                Array.from(streamingElements).forEach(element => {
                    const href = element.getAttribute('href') || '';
                    const text = element.textContent || '';
                    
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
                        extractHubCloudLinks(intermediate.url, title, (hubCloudLinks) => {
                            // Filter for specific episode if requested
                            let filteredLinks = hubCloudLinks;
                            if (episodeInfo && episodeInfo.isEpisode) {
                                filteredLinks = hubCloudLinks.filter(link => {
                                    return matchesEpisode(link.fileName || link.title || '', episodeInfo);
                                });
                            }
                            allStreamingLinks.push(...filteredLinks);
                            extractedCount++;
                            
                            // Early termination if we found episode-specific links
                            if (episodeInfo && episodeInfo.isEpisode && filteredLinks.length > 0) {
                                console.log(`Found ${filteredLinks.length} links for S${episodeInfo.season.toString().padStart(2, '0')}E${episodeInfo.episode.toString().padStart(2, '0')} - stopping search`);
                                callback(allStreamingLinks);
                                return;
                            }
                            
                            if (extractedCount === totalToExtract) {
                                processedPages++;
                                if (processedPages === downloadLinks.length) {
                                    callback(allStreamingLinks);
                                }
                            }
                        });
                    } else if (intermediate.source === 'GDFlix' || intermediate.source === 'GDLink') {
                        extractGDFlixLinks(intermediate.url, title, (gdFlixLinks) => {
                            // Filter for specific episode if requested
                            let filteredLinks = gdFlixLinks;
                            if (episodeInfo && episodeInfo.isEpisode) {
                                filteredLinks = gdFlixLinks.filter(link => {
                                    return matchesEpisode(link.fileName || link.title || '', episodeInfo);
                                });
                            }
                            allStreamingLinks.push(...filteredLinks);
                            extractedCount++;
                            
                            // Early termination if we found episode-specific links
                            if (episodeInfo && episodeInfo.isEpisode && filteredLinks.length > 0) {
                                console.log(`Found ${filteredLinks.length} links for S${episodeInfo.season.toString().padStart(2, '0')}E${episodeInfo.episode.toString().padStart(2, '0')} - stopping search`);
                                callback(allStreamingLinks);
                                return;
                            }
                            
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
    });
}

// Main function to search and extract links
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

// CLI Interface
if (require.main === module) {
    const query = process.argv[2];
    
    if (!query) {
        console.log('Usage: node moviesdrive-extractor.js "movie or show name"');
        console.log('Example: node moviesdrive-extractor.js "Avengers Endgame"');
        process.exit(1);
    }
    
    console.log('MoviesDrive Streaming Link Extractor');
    console.log('====================================\n');
    
    findStreamingLinks(query, (links) => {
        if (links.length === 0) {
            console.log('No streaming links found.');
        } else {
            // Format links according to requested structure
            const formattedLinks = links.map(link => ({
                name: `MoviesDrive (${link.source || 'Unknown'}) - ${link.quality || 'Unknown'}`,
                title: link.fileName || 'Unknown Title',
                url: link.url,
                quality: link.quality || 'Unknown',
                size: link.size || 'Unknown',
                fileName: link.fileName || undefined
            }));
            
            // Output as JSON array
            console.log(JSON.stringify(formattedLinks, null, 2));
        }
    });
}

// Export functions for use as module
module.exports = {
    findStreamingLinks,
    searchContent,
    extractStreamingLinks
};