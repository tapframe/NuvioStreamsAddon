/**
 * MoviesMod Provider for Stremio Addon
 * Supports both movies and TV series
 */

const axios = require('axios');
const cheerio = require('cheerio');
const FormData = require('form-data');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');

const BASE_URL = 'https://moviesmod.chat';

// Helper function to extract quality from text
function extractQuality(text) {
    if (!text) return 'Unknown';
    
    const qualityMatch = text.match(/(480p|720p|1080p|2160p|4k)/i);
    if (qualityMatch) {
        return qualityMatch[1];
    }
    
    // Try to extract from full text
    const cleanMatch = text.match(/(480p|720p|1080p|2160p|4k)[^)]*\)/i);
    if (cleanMatch) {
        return cleanMatch[0];
    }
    
    return 'Unknown';
}

// Search for content on MoviesMod
async function searchMoviesMod(query) {
    try {
        const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
        const { data } = await axios.get(searchUrl);
        const $ = cheerio.load(data);

        const results = [];
        $('.latestPost').each((i, element) => {
            const linkElement = $(element).find('a');
            const title = linkElement.attr('title');
            const url = linkElement.attr('href');
            if (title && url) {
                results.push({ title, url });
            }
        });

        return results;
    } catch (error) {
        console.error(`[MoviesMod] Error searching: ${error.message}`);
        return [];
    }
}

// Extract download links from a movie/series page
async function extractDownloadLinks(moviePageUrl) {
    try {
        const { data } = await axios.get(moviePageUrl);
        const $ = cheerio.load(data);
        const links = [];
        const contentBox = $('.thecontent');

        // Get all relevant headers (for movies and TV shows) in document order
        const headers = contentBox.find('h3:contains("Season"), h4');
        
        headers.each((i, el) => {
            const header = $(el);
            const headerText = header.text().trim();
            
            // Define the content block for this header
            const blockContent = header.nextUntil('h3, h4');

            if (header.is('h3') && headerText.toLowerCase().includes('season')) {
                // TV Show Logic
                const linkElements = blockContent.find('a.maxbutton-episode-links, a.maxbutton-batch-zip');
                linkElements.each((j, linkEl) => {
                    const buttonText = $(linkEl).text().trim();
                    const linkUrl = $(linkEl).attr('href');
                    if (linkUrl && !buttonText.toLowerCase().includes('batch')) {
                        links.push({
                            quality: `${headerText} - ${buttonText}`,
                            url: linkUrl
                        });
                    }
                });
            } else if (header.is('h4')) {
                // Movie Logic
                const linkElement = blockContent.find('a[href*="modrefer.in"]').first();
                if (linkElement.length > 0) {
                    const link = linkElement.attr('href');
                    const cleanQuality = extractQuality(headerText);
                    links.push({
                        quality: cleanQuality,
                        url: link
                    });
                }
            }
        });

        return links;
    } catch (error) {
        console.error(`[MoviesMod] Error extracting download links: ${error.message}`);
        return [];
    }
}

// Resolve intermediate links (dramadrip, episodes.modpro.blog, modrefer.in)
async function resolveIntermediateLink(initialUrl, refererUrl) {
    try {
        const urlObject = new URL(initialUrl);

        if (urlObject.hostname.includes('dramadrip.com')) {
            const { data: dramaData } = await axios.get(initialUrl, { headers: { 'Referer': refererUrl } });
            const $$ = cheerio.load(dramaData);
            
            // First try the new cinematickit.org links (for quality-specific episodes)
            const cinematicKitLinks = [];
            $$('a[href*="cinematickit.org"]').each((i, el) => {
                const link = $$(el).attr('href');
                const text = $$(el).text().trim();
                if (link && text) {
                    cinematicKitLinks.push({ url: link, quality: text });
                }
            });
            
            if (cinematicKitLinks.length > 0) {
                console.log(`[MoviesMod] Found ${cinematicKitLinks.length} cinematickit.org quality links`);
                
                // Process all quality links in parallel
                const qualityPromises = cinematicKitLinks.map(async (qualityLink) => {
                    try {
                        return await resolveIntermediateLink(qualityLink.url, initialUrl);
                    } catch (error) {
                        console.error(`[MoviesMod] Error processing quality link ${qualityLink.quality}: ${error.message}`);
                        return [];
                    }
                });
                
                const allQualityResults = await Promise.all(qualityPromises);
                
                // Flatten and add quality info to each result
                const allLinks = [];
                allQualityResults.forEach((results, i) => {
                    if (Array.isArray(results)) {
                        results.forEach(result => {
                            allLinks.push({
                                ...result,
                                qualityInfo: cinematicKitLinks[i].quality // Add quality info
                            });
                        });
                    }
                });
                
                return allLinks;
            }
            
            // Fallback to old episodes.modpro.blog method
            const episodeBlogLink = $$('a[href*="episodes.modpro.blog"]').attr('href');
            if (episodeBlogLink) {
                return await resolveIntermediateLink(episodeBlogLink, initialUrl);
            }
            
            console.error('[MoviesMod] Could not find cinematickit.org or episodes.modpro.blog links on dramadrip page.');
            return [];
            
        } else if (urlObject.hostname.includes('cinematickit.org')) {
            // Handle cinematickit.org pages
            const { data } = await axios.get(initialUrl, { headers: { 'Referer': refererUrl } });
            const $ = cheerio.load(data);
            const finalLinks = [];
            
            // Look for episode links on cinematickit.org
            $('a[href*="driveseed.org"]').each((i, el) => {
                const link = $(el).attr('href');
                const text = $(el).text().trim();
                if (link && text && !text.toLowerCase().includes('batch')) {
                    finalLinks.push({
                        server: text.replace(/\s+/g, ' '),
                        url: link,
                    });
                }
            });
            
            // If no driveseed links found, try other patterns
            if (finalLinks.length === 0) {
                $('a[href*="modrefer.in"], a[href*="dramadrip.com"]').each((i, el) => {
                    const link = $(el).attr('href');
                    const text = $(el).text().trim();
                    if (link && text) {
                        finalLinks.push({
                            server: text.replace(/\s+/g, ' '),
                            url: link,
                        });
                    }
                });
            }
            
            return finalLinks;

        } else if (urlObject.hostname.includes('episodes.modpro.blog')) {
            const { data } = await axios.get(initialUrl, { headers: { 'Referer': refererUrl } });
            const $ = cheerio.load(data);
            const finalLinks = [];
            
            $('.entry-content a[href*="driveseed.org"]').each((i, el) => {
                const link = $(el).attr('href');
                const text = $(el).text().trim();
                if (link && text && !text.toLowerCase().includes('batch')) {
                    finalLinks.push({
                        server: text.replace(/\s+/g, ' '),
                        url: link,
                    });
                }
            });
            return finalLinks;

        } else if (urlObject.hostname.includes('modrefer.in')) {
            const encodedUrl = urlObject.searchParams.get('url');
            if (!encodedUrl) {
                console.error('[MoviesMod] Could not find encoded URL in modrefer.in link.');
                return [];
            }

            const decodedUrl = Buffer.from(encodedUrl, 'base64').toString('utf8');
            const { data } = await axios.get(decodedUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Referer': refererUrl,
                }
            });

            const $ = cheerio.load(data);
            const finalLinks = [];
            
            $('.timed-content-client_show_0_5_0 a').each((i, el) => {
                const link = $(el).attr('href');
                const text = $(el).text().trim();
                if (link) {
                    finalLinks.push({
                        server: text,
                        url: link,
                    });
                }
            });
            return finalLinks;
        } else {
            console.warn(`[MoviesMod] Unknown hostname: ${urlObject.hostname}`);
            return [];
        }
    } catch (error) {
        console.error(`[MoviesMod] Error resolving intermediate link: ${error.message}`);
        return [];
    }
}

// Resolve driveseed.org links to get download options
async function resolveDriveseedLink(driveseedUrl) {
    try {
        const { data } = await axios.get(driveseedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Referer': 'https://links.modpro.blog/',
            }
        });

        const redirectMatch = data.match(/window\.location\.replace\("([^"]+)"\)/);

        if (redirectMatch && redirectMatch[1]) {
            const finalPath = redirectMatch[1];
            const finalUrl = `https://driveseed.org${finalPath}`;
            
            const finalResponse = await axios.get(finalUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Referer': driveseedUrl,
                }
            });

            const $ = cheerio.load(finalResponse.data);
            const downloadOptions = [];
            let size = null;
            let fileName = null;

            // Extract size and filename from the list
            $('ul.list-group li').each((i, el) => {
                const text = $(el).text();
                if (text.includes('Size :')) {
                    size = text.split(':')[1].trim();
                } else if (text.includes('Name :')) {
                    fileName = text.split(':')[1].trim();
                }
            });

            // Find Resume Cloud button (primary)
            const resumeCloudLink = $('a:contains("Resume Cloud")').attr('href');
            if (resumeCloudLink) {
                downloadOptions.push({
                    title: 'Resume Cloud',
                    type: 'resume',
                    url: `https://driveseed.org${resumeCloudLink}`,
                    priority: 1
                });
            }

            // Find Resume Worker Bot (fallback)
            const workerSeedLink = $('a:contains("Resume Worker Bot")').attr('href');
            if (workerSeedLink) {
                downloadOptions.push({
                    title: 'Resume Worker Bot',
                    type: 'worker',
                    url: workerSeedLink,
                    priority: 2
                });
            }

            // Find Instant Download (final fallback)
            const instantDownloadLink = $('a:contains("Instant Download")').attr('href');
            if (instantDownloadLink) {
                downloadOptions.push({
                    title: 'Instant Download',
                    type: 'instant',
                    url: instantDownloadLink,
                    priority: 3
                });
            }

            // Sort by priority
            downloadOptions.sort((a, b) => a.priority - b.priority);
            return { downloadOptions, size, fileName };
        }
        return { downloadOptions: [], size: null, fileName: null };
    } catch (error) {
        console.error(`[MoviesMod] Error resolving Driveseed link: ${error.message}`);
        return { downloadOptions: [], size: null, fileName: null };
    }
}

// Resolve Resume Cloud link to final download URL
async function resolveResumeCloudLink(resumeUrl) {
    try {
        const { data } = await axios.get(resumeUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Referer': 'https://driveseed.org/',
            }
        });
        const $ = cheerio.load(data);
        const downloadLink = $('a:contains("Cloud Resume Download")').attr('href');
        return downloadLink || null;
    } catch (error) {
        console.error(`[MoviesMod] Error resolving Resume Cloud link: ${error.message}`);
        return null;
    }
}

// Resolve Worker Seed link to final download URL
async function resolveWorkerSeedLink(workerSeedUrl) {
    try {
        console.log(`[MoviesMod] Resolving Worker-seed link: ${workerSeedUrl}`);

        const jar = new CookieJar();
        const session = wrapper(axios.create({
            jar,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            }
        }));

        // Step 1: GET the page to get the script content and cookies
        console.log(`[MoviesMod] Step 1: Fetching page to get script content and cookies...`);
        const { data: pageHtml } = await session.get(workerSeedUrl);

        // Step 2: Use regex to extract the token and the correct ID from the script
        const scriptTags = pageHtml.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/g);
        
        if (!scriptTags) {
            console.error('[MoviesMod] Could not find any script tags on the page.');
            return null;
        }

        const scriptContent = scriptTags.find(s => s.includes("formData.append('token'"));

        if (!scriptContent) {
            console.error('[MoviesMod] Could not find the relevant script tag containing formData.append.');
            
            // Debug: Log available script content
            console.log(`[MoviesMod] Found ${scriptTags.length} script tags. Checking for token patterns...`);
            scriptTags.forEach((script, i) => {
                if (script.includes('token') || script.includes('formData')) {
                    console.log(`[MoviesMod] Script ${i} snippet:`, script.substring(0, 300));
                }
            });
            
            return null;
        }

        const tokenMatch = scriptContent.match(/formData\.append\('token', '([^']+)'\)/);
        const idMatch = scriptContent.match(/fetch\('\/download\?id=([^']+)',/);

        if (!tokenMatch || !tokenMatch[1] || !idMatch || !idMatch[1]) {
            console.error('[MoviesMod] Could not extract token or correct ID from the script.');
            console.log('[MoviesMod] Script content snippet:', scriptContent.substring(0, 500));
            
            // Try alternative patterns
            const altTokenMatch = scriptContent.match(/token['"]?\s*[:=]\s*['"]([^'"]+)['"]/);
            const altIdMatch = scriptContent.match(/id['"]?\s*[:=]\s*['"]([^'"]+)['"]/);
            
            if (altTokenMatch && altIdMatch) {
                console.log('[MoviesMod] Found alternative patterns, trying those...');
                const token = altTokenMatch[1];
                const id = altIdMatch[1];
                console.log(`[MoviesMod] Alternative token: ${token.substring(0, 20)}...`);
                console.log(`[MoviesMod] Alternative id: ${id}`);
                
                // Continue with these values
                return await makeWorkerSeedRequest(session, token, id, workerSeedUrl);
            }
            
            return null;
        }

        const token = tokenMatch[1];
        const correctId = idMatch[1];
        console.log(`[MoviesMod] Step 2: Extracted token: ${token.substring(0, 20)}...`);
        console.log(`[MoviesMod] Step 2: Extracted correct ID: ${correctId}`);

        return await makeWorkerSeedRequest(session, token, correctId, workerSeedUrl);

    } catch (error) {
        console.error(`[MoviesMod] Error resolving WorkerSeed link: ${error.message}`);
        if (error.response) {
            console.error('[MoviesMod] Error response data:', error.response.data);
        }
        return null;
    }
}

// Helper function to make the actual WorkerSeed API request
async function makeWorkerSeedRequest(session, token, correctId, workerSeedUrl) {
    // Step 3: Make the POST request with the correct data using the same session
    const apiUrl = `https://workerseed.dev/download?id=${correctId}`;
    
    const formData = new FormData();
    formData.append('token', token);
   
    console.log(`[MoviesMod] Step 3: POSTing to endpoint: ${apiUrl} with extracted token.`);

    // Use the session instance, which will automatically include the cookies
    const { data: apiResponse } = await session.post(apiUrl, formData, {
        headers: {
            ...formData.getHeaders(),
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Referer': workerSeedUrl,
            'x-requested-with': 'XMLHttpRequest'
        }
    });

    if (apiResponse && apiResponse.url) {
        console.log(`[MoviesMod] SUCCESS! Final video link from Worker-seed API: ${apiResponse.url}`);
        return apiResponse.url;
    } else {
        console.log('[MoviesMod] Worker-seed API did not return a URL. Full response:');
        console.log(apiResponse);
        return null;
    }
}

// Resolve Video Seed (Instant Download) link
async function resolveVideoSeedLink(videoSeedUrl) {
    try {
        const urlParams = new URLSearchParams(new URL(videoSeedUrl).search);
        const keys = urlParams.get('url');

        if (keys) {
            const apiUrl = `${new URL(videoSeedUrl).origin}/api`;
            const formData = new FormData();
            formData.append('keys', keys);

            const apiResponse = await axios.post(apiUrl, formData, {
                headers: {
                    ...formData.getHeaders(),
                    'x-token': new URL(videoSeedUrl).hostname
                }
            });

            if (apiResponse.data && apiResponse.data.url) {
                return apiResponse.data.url;
            }
        }
        return null;
    } catch (error) {
        console.error(`[MoviesMod] Error resolving VideoSeed link: ${error.message}`);
        return null;
    }
}

// Main function to get streams for TMDB content
async function getMoviesModStreams(tmdbId, mediaType, seasonNum = null, episodeNum = null) {
    try {
        console.log(`[MoviesMod] Fetching streams for TMDB ${mediaType}/${tmdbId}`);
        
        if (!tmdbId) {
            console.log('[MoviesMod] No TMDB ID provided');
            return [];
        }

        // We need to fetch title and year from TMDB API
        const TMDB_API_KEY = process.env.TMDB_API_KEY;
        if (!TMDB_API_KEY) {
            console.log('[MoviesMod] TMDB_API_KEY not configured. Cannot fetch metadata.');
            return [];
        }

        // Fetch metadata from TMDB
        let title, year;
        try {
            const TMDB_API_URL = 'https://api.themoviedb.org/3';
            let detailsUrl;
            if (mediaType === 'movie') {
                detailsUrl = `${TMDB_API_URL}/movie/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`;
            } else {
                detailsUrl = `${TMDB_API_URL}/tv/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`;
            }

            const { default: fetch } = await import('node-fetch');
            const response = await fetch(detailsUrl);
            if (!response.ok) {
                throw new Error(`TMDB API error: ${response.status}`);
            }
            const tmdbDetails = await response.json();

            if (mediaType === 'movie') {
                title = tmdbDetails.title;
                year = tmdbDetails.release_date ? tmdbDetails.release_date.substring(0, 4) : null;
            } else {
                title = tmdbDetails.name;
                year = tmdbDetails.first_air_date ? tmdbDetails.first_air_date.substring(0, 4) : null;
            }

            if (!title) {
                console.log('[MoviesMod] Could not get title from TMDB');
                return [];
            }

            console.log(`[MoviesMod] Found metadata: ${title} (${year})`);
        } catch (error) {
            console.error(`[MoviesMod] Error fetching TMDB metadata: ${error.message}`);
            return [];
        }

        // Search for the content
        const searchResults = await searchMoviesMod(title);
        if (searchResults.length === 0) {
            console.log(`[MoviesMod] No search results found for "${title}"`);
            return [];
        }

        // Find the best match (simple heuristic - first result for now)
        const selectedResult = searchResults[0];
        console.log(`[MoviesMod] Selected: ${selectedResult.title}`);

        // Extract download links from the page
        const downloadLinks = await extractDownloadLinks(selectedResult.url);
        if (downloadLinks.length === 0) {
            console.log('[MoviesMod] No download links found');
            return [];
        }

        console.log(`[MoviesMod] Found ${downloadLinks.length} download options`);

        // For TV series, filter by season if specified
        let relevantLinks = downloadLinks;
        if (mediaType === 'tv' || mediaType === 'series') {
            if (seasonNum !== null) {
                relevantLinks = downloadLinks.filter(link => 
                    link.quality.toLowerCase().includes(`season ${seasonNum}`) ||
                    link.quality.toLowerCase().includes(`s${seasonNum}`)
                );
            }
        }
        
        // Filter out all 480p links to ensure only higher qualities are processed
        const initialCount = relevantLinks.length;
        relevantLinks = relevantLinks.filter(link => !link.quality.toLowerCase().includes('480p'));
        console.log(`[MoviesMod] Filtered out 480p links. Removed ${initialCount - relevantLinks.length} links. Remaining: ${relevantLinks.length}`);

        const streams = [];
        const processedFileNames = new Set(); // Set to track processed filenames for deduplication

        // Process each relevant link in parallel for better performance
        const linkPromises = relevantLinks.map(async (link) => {
            try {
                console.log(`[MoviesMod] Processing: ${link.quality}`);

                // Resolve intermediate link (modrefer.in, dramadrip, etc.)
                const finalLinks = await resolveIntermediateLink(link.url, selectedResult.url);
                
                if (finalLinks.length === 0) {
                    console.log(`[MoviesMod] No final links found for ${link.quality}`);
                    return [];
                }

                // For TV series with episodes, let user pick episode or use first episode
                let targetLinks = finalLinks;
                if (mediaType === 'tv' && episodeNum !== null) {
                    // Try to find specific episode
                    const episodeLinks = finalLinks.filter(fl => 
                        fl.server.toLowerCase().includes(`episode ${episodeNum}`) ||
                        fl.server.toLowerCase().includes(`ep ${episodeNum}`) ||
                        fl.server.toLowerCase().includes(`e${episodeNum}`)
                    );
                    if (episodeLinks.length > 0) {
                        targetLinks = episodeLinks;
                    } else {
                        // If no specific episode found, skip this quality
                        console.log(`[MoviesMod] No episode ${episodeNum} found for ${link.quality}`);
                        return [];
                    }
                }

                // Process each target link in parallel (usually just one for movies, or specific episode for TV)
                const targetLinkPromises = targetLinks.map(async (targetLink) => {
                    const { downloadOptions, size: driveseedSize, fileName } = await resolveDriveseedLink(targetLink.url);
                    
                    if (fileName && processedFileNames.has(fileName)) {
                        console.log(`[MoviesMod] Skipping duplicate file: ${fileName}`);
                        return null;
                    }
                    if (fileName) {
                        processedFileNames.add(fileName);
                    }

                    if (downloadOptions.length === 0) {
                        console.log(`[MoviesMod] No download options found for ${targetLink.server}`);
                        return null;
                    }

                    // Process all download options in parallel and take the first successful one
                    const methodPromises = downloadOptions.map(async (option) => {
                        try {
                            let finalDownloadUrl = null;
                            let usedMethod = null;

                            if (option.type === 'resume') {
                                finalDownloadUrl = await resolveResumeCloudLink(option.url);
                                usedMethod = 'Resume Cloud';
                            } else if (option.type === 'worker') {
                                finalDownloadUrl = await resolveWorkerSeedLink(option.url);
                                usedMethod = 'Resume Worker Bot';
                            } else if (option.type === 'instant') {
                                finalDownloadUrl = await resolveVideoSeedLink(option.url);
                                usedMethod = 'Instant Download';
                            }

                            if (finalDownloadUrl) {
                                return { url: finalDownloadUrl, method: usedMethod, type: option.type };
                            }
                            return null;
                        } catch (error) {
                            console.log(`[MoviesMod] Failed to resolve ${option.type}: ${error.message}`);
                            return null;
                        }
                    });

                    // Wait for all methods to complete and take the first successful one
                    // Priority: Resume Cloud > Resume Worker Bot > Instant Download
                    const methodResults = await Promise.all(methodPromises);
                    const successfulResults = methodResults.filter(result => result !== null);
                    
                    if (successfulResults.length === 0) {
                        console.log(`[MoviesMod] All download methods failed for ${targetLink.server}`);
                        return null;
                    }

                    // Sort by priority: resume > worker > instant
                    const priorityOrder = { 'resume': 1, 'worker': 2, 'instant': 3 };
                    successfulResults.sort((a, b) => priorityOrder[a.type] - priorityOrder[b.type]);
                    
                    const selectedResult = successfulResults[0];
                    console.log(`[MoviesMod] Successfully resolved using ${selectedResult.method}`);

                    // Extract quality and build detailed stream name
                    let actualQuality = 'Unknown';
                    let additionalInfo = [];
                    let episodeInfo = '';
                    let sourceInfo = '';
                    let sizeInfo = driveseedSize;
                    
                    // --- 1. Extract Size Information First (if not already found) ---
                    if (!sizeInfo) {
                        if (targetLink.qualityInfo) {
                            // For cinematickit links, size is in parentheses, e.g., "(220MB)"
                            const sizeMatch = targetLink.qualityInfo.match(/\(([^)]+)\)/);
                            if (sizeMatch && sizeMatch[1]) {
                                sizeInfo = sizeMatch[1];
                            }
                        } else if (targetLink.quality) {
                            // For main page links, size is in square brackets, e.g., "[1.9GB]"
                            const sizeMatch = targetLink.quality.match(/\[([^\]]+)\]/);
                            if (sizeMatch && sizeMatch[1]) {
                                sizeInfo = sizeMatch[1];
                            }
                        }
                    }

                    // Build episode information for TV series
                    if (mediaType === 'tv' && seasonNum !== null && episodeNum !== null) {
                        episodeInfo = `S${seasonNum.toString().padStart(2, '0')}E${episodeNum.toString().padStart(2, '0')}`;
                    }
                    
                    // --- 2. Extract Quality and Other Details ---
                    if (targetLink.qualityInfo) {
                        const qualityInfo = targetLink.qualityInfo;
                        console.log(`[MoviesMod] Using quality info from cinematickit: ${qualityInfo}`);
                        
                        // Extract quality from qualityInfo
                        const qualityMatch = qualityInfo.match(/(480p|720p|1080p|2160p|4k)/i);
                        if (qualityMatch) {
                            actualQuality = qualityMatch[1];
                        }
                        
                        // Extract codec info from qualityInfo
                        if (qualityInfo.toLowerCase().includes('x264')) additionalInfo.push('x264');
                        if (qualityInfo.toLowerCase().includes('x265') || qualityInfo.toLowerCase().includes('hevc')) additionalInfo.push('HEVC');
                        if (qualityInfo.toLowerCase().includes('10bit')) additionalInfo.push('10-bit');
                        
                        // Extract size info from qualityInfo (e.g., "(220MB)", "(1.9GB)")
                        const sizeMatch = qualityInfo.match(/\(([^)]+)\)/);
                        if (sizeMatch && sizeMatch[1]) {
                            sizeInfo = sizeMatch[1];
                        }
                        
                    } else if (selectedResult.url) {
                        // Fallback: Extract from URL filename
                        const urlPath = selectedResult.url.split('/').pop() || '';
                        const qualityMatch = urlPath.match(/(480p|720p|1080p|2160p|4k)/i);
                        if (qualityMatch) {
                            actualQuality = qualityMatch[1];
                        } else {
                            // Final fallback to the original quality extraction from description
                            actualQuality = extractQuality(link.quality);
                        }
                        
                        // Extract additional info from filename
                        if (urlPath.toLowerCase().includes('x264')) additionalInfo.push('x264');
                        if (urlPath.toLowerCase().includes('x265') || urlPath.toLowerCase().includes('hevc')) additionalInfo.push('HEVC');
                        if (urlPath.toLowerCase().includes('10bit')) additionalInfo.push('10-bit');
                        if (urlPath.toLowerCase().includes('hdr')) additionalInfo.push('HDR');
                        
                        // Extract language info from filename
                        const langMatches = urlPath.match(/(Hindi|English|Korean|Tamil|Telugu|Spanish|French|Dual|Multi)/gi);
                        if (langMatches) {
                            const uniqueLangs = [...new Set(langMatches.map(lang => lang.charAt(0).toUpperCase() + lang.slice(1).toLowerCase()))];
                            if (uniqueLangs.includes('Multi') || uniqueLangs.length > 2) {
                                additionalInfo.push('Multi Audio');
                            } else if (uniqueLangs.includes('Dual') || uniqueLangs.length === 2) {
                                additionalInfo.push('Dual Audio');
                            } else if (uniqueLangs.length === 1 && !uniqueLangs.includes('English')) {
                                additionalInfo.push(uniqueLangs[0]);
                            }
                        }
                        
                        // Extract subtitle info
                        if (urlPath.toLowerCase().includes('msubs') || urlPath.toLowerCase().includes('subs')) {
                            additionalInfo.push('Subs');
                        }
                    }
                    
                    // Build source information
                    sourceInfo = `MoviesMod [${selectedResult.method}]`;
                    
                    // Build simple name for the stream (just provider and basic quality info)
                    let streamName = 'MoviesMod';
                    if (actualQuality !== 'Unknown') {
                        streamName += ` - ${actualQuality}`;
                    }
                    
                    // Add key technical details to name (codec and bit depth only)
                    let nameExtras = [];
                    if (targetLink.qualityInfo) {
                        if (targetLink.qualityInfo.toLowerCase().includes('10bit')) nameExtras.push('10-bit');
                        if (targetLink.qualityInfo.toLowerCase().includes('x265') || targetLink.qualityInfo.toLowerCase().includes('hevc')) nameExtras.push('HEVC');
                        else if (targetLink.qualityInfo.toLowerCase().includes('x264')) nameExtras.push('x264');
                    } else if (selectedResult.url) {
                        const urlPath = selectedResult.url.split('/').pop() || '';
                        if (urlPath.toLowerCase().includes('10bit')) nameExtras.push('10-bit');
                        if (urlPath.toLowerCase().includes('x265') || urlPath.toLowerCase().includes('hevc')) nameExtras.push('HEVC');
                        else if (urlPath.toLowerCase().includes('x264')) nameExtras.push('x264');
                    }
                    
                    if (nameExtras.length > 0) {
                        streamName += ` | ${nameExtras.join(' | ')}`;
                    }
                    
                    // Build detailed title with all information
                    let detailedTitle = '';
                    
                    // Use filename from driveseed if available for a more accurate title
                    if (fileName) {
                        // Clean up filename (remove extension, replace dots with spaces)
                        const cleanFileName = fileName.replace(/\.[^/.]+$/, "").replace(/\./g, ' ');
                        detailedTitle = cleanFileName;
                    } else if (mediaType === 'tv' && seasonNum !== null && episodeNum !== null) {
                        detailedTitle = `${title} S${seasonNum.toString().padStart(2, '0')}E${episodeNum.toString().padStart(2, '0')}`;
                        
                        // Try to extract episode title from filename
                        if (selectedResult.url) {
                            const filename = selectedResult.url.split('/').pop() || '';
                            const episodeTitleMatch = filename.match(/(?:S\d+)?E\d+\.([^.]+)(?:\.\d+p)?/i);
                            if (episodeTitleMatch && episodeTitleMatch[1]) {
                                const cleanEpisodeTitle = episodeTitleMatch[1].replace(/[._]/g, ' ').trim();
                                if (cleanEpisodeTitle.length > 3 && !cleanEpisodeTitle.match(/^\d+p$/i)) {
                                    detailedTitle += ` • ${cleanEpisodeTitle}`;
                                }
                            }
                        }
                    } else {
                        // For movies
                        detailedTitle = title;
                        if (year) {
                            detailedTitle += ` (${year})`;
                        }
                    }
                    
                    // Add technical details line
                    let techDetails = [];
                    
                    // Add download method
                    techDetails.push(`[${selectedResult.method}]`);
                    
                    if (sizeInfo) {
                        techDetails.push(sizeInfo);
                    }

                    // Add quality info
                    if (actualQuality !== 'Unknown') {
                        techDetails.push(actualQuality);
                    }
                    
                    // Add codec and bit depth
                    if (targetLink.qualityInfo) {
                        if (targetLink.qualityInfo.toLowerCase().includes('x264')) techDetails.push('x264');
                        if (targetLink.qualityInfo.toLowerCase().includes('x265') || targetLink.qualityInfo.toLowerCase().includes('hevc')) techDetails.push('HEVC');
                        if (targetLink.qualityInfo.toLowerCase().includes('10bit')) techDetails.push('10-bit');
                        if (targetLink.qualityInfo.toLowerCase().includes('hdr')) techDetails.push('HDR');
                        
                        // Add size
                        const sizeMatch = targetLink.qualityInfo.match(/\(([^)]+)\)/);
                        if (sizeMatch) {
                            techDetails.push(sizeMatch[1]);
                        }
                    } else if (selectedResult.url) {
                        const urlPath = selectedResult.url.split('/').pop() || '';
                        if (urlPath.toLowerCase().includes('x264')) techDetails.push('x264');
                        if (urlPath.toLowerCase().includes('x265') || urlPath.toLowerCase().includes('hevc')) techDetails.push('HEVC');
                        if (urlPath.toLowerCase().includes('10bit')) techDetails.push('10-bit');
                        if (urlPath.toLowerCase().includes('hdr')) techDetails.push('HDR');
                        
                        // Add language info
                        const langMatches = urlPath.match(/(Hindi|English|Korean|Tamil|Telugu|Spanish|French|Dual|Multi)/gi);
                        if (langMatches) {
                            const uniqueLangs = [...new Set(langMatches.map(lang => lang.charAt(0).toUpperCase() + lang.slice(1).toLowerCase()))];
                            if (uniqueLangs.includes('Multi') || uniqueLangs.length > 2) {
                                techDetails.push('Multi Audio');
                            } else if (uniqueLangs.includes('Dual') || uniqueLangs.length === 2) {
                                techDetails.push('Dual Audio');
                            } else if (uniqueLangs.length === 1 && !uniqueLangs.includes('English')) {
                                techDetails.push(uniqueLangs[0]);
                            }
                        }
                        
                        // Add subtitle info
                        if (urlPath.toLowerCase().includes('msubs') || urlPath.toLowerCase().includes('subs')) {
                            techDetails.push('Subs');
                        }
                    }
                    
                    // Combine title with tech details
                    if (techDetails.length > 0) {
                        detailedTitle += `\n${techDetails.join(' • ')}`;
                    }
                    
                    return {
                        name: streamName,
                        title: detailedTitle,
                        url: selectedResult.url,
                        quality: actualQuality,
                        provider: 'MoviesMod',
                        method: selectedResult.method,
                        size: sizeInfo,
                        fileName: fileName
                    };
                });

                // Wait for all target links to be processed in parallel
                const targetResults = await Promise.all(targetLinkPromises);
                return targetResults.filter(result => result !== null);

            } catch (error) {
                console.error(`[MoviesMod] Error processing link ${link.quality}: ${error.message}`);
                return [];
            }
        });

        // Wait for all links to be processed in parallel
        console.log(`[MoviesMod] Processing ${relevantLinks.length} download options in parallel...`);
        const allResults = await Promise.all(linkPromises);
        
        // Flatten the results and add them to streams array
        allResults.forEach(results => {
            if (Array.isArray(results)) {
                streams.push(...results);
            }
        });

        console.log(`[MoviesMod] Successfully extracted ${streams.length} streams`);
        return streams;

    } catch (error) {
        console.error(`[MoviesMod] Error getting streams: ${error.message}`);
        return [];
    }
}

module.exports = {
    getMoviesModStreams
}; 