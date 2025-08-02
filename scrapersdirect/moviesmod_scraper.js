const axios = require('axios');
const cheerio = require('cheerio');
const readline = require('readline');
const FormData = require('form-data');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const { URLSearchParams, URL } = require('url');

const BASE_URL = 'https://moviesmod.chat';

// We'll implement this based on the search function we already designed.
async function searchMovies(query) {
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

        console.log(`Found ${results.length} results for "${query}"`);
        return results;
    } catch (error) {
        console.error(`Error searching on MoviesMod: ${error.message}`);
        return [];
    }
}

// This function will extract the actual download links from a movie's page.
async function extractDownloadLinks(moviePageUrl) {
    try {
        console.log(`\nExtracting initial links from: ${moviePageUrl}`);
        const { data } = await axios.get(moviePageUrl);
        const $ = cheerio.load(data);
        const links = [];
        const contentBox = $('.thecontent'); // Target the main content area

        // Get all relevant headers (for movies and TV shows) in document order
        const headers = contentBox.find('h3:contains("Season"), h4');
        
        headers.each((i, el) => {
            const header = $(el);
            const headerText = header.text().trim();
            
            // Define the content block for this header. It's everything until the next header.
            const blockContent = header.nextUntil('h3, h4');

            // Find links within this specific block by looking for the button classes
            const linkElements = blockContent.find('a.maxbutton-episode-links, a.maxbutton-batch-zip');
            
            if (header.is('h3') && headerText.toLowerCase().includes('season')) {
                 // TV Show Logic
                 linkElements.each((j, linkEl) => {
                    const buttonText = $(linkEl).text().trim(); // "Episode Links" or "Batch/Zip File"
                    const linkUrl = $(linkEl).attr('href');
                    if (linkUrl) {
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
                     let cleanQuality = 'Unknown Quality';
                     const qualityMatch = headerText.match(/(480p|720p|1080p|2160p|4k).*/i);
                     if (qualityMatch) {
                         cleanQuality = qualityMatch[0].replace(/\[.*/, '').trim();
                     }
                     links.push({
                         quality: cleanQuality,
                         url: link
                     });
                }
            }
        });

        if (links.length === 0) {
            console.log('No download pages found with the expected structure.');
        }

        return links;
    } catch (error) {
        console.error(`Error extracting download links: ${error.message}`);
        return [];
    }
}

// This function will take a modrefer.in link and extract the next set of links.
async function resolveIntermediateLink(initialUrl, refererUrl, quality) {
    try {
        const urlObject = new URL(initialUrl);

        if (urlObject.hostname.includes('dramadrip.com')) {
            console.log(`\nHandling dramadrip.com link: ${initialUrl}`);
            const { data: dramaData } = await axios.get(initialUrl, { headers: { 'Referer': refererUrl } });
            const $$ = cheerio.load(dramaData);
            
            // New logic: Find the link that matches the selected quality
            let episodeBlogLink = null;
            const seasonMatch = quality.match(/Season \d+/i);
            const qualityMatch = quality.match(/(480p|720p|1080p|2160p|4k)/i);
            
            if (seasonMatch && qualityMatch) {
                const seasonIdentifier = seasonMatch[0]; // e.g., "Season 3"
                const qualityIdentifier = qualityMatch[0]; // e.g., "1080p"
                
                $$('a[href*="episodes.modpro.blog"], a[href*="cinematickit.org"]').each((i, el) => {
                    const link = $$(el);
                    const linkText = link.text().trim(); // "1080p x264 (1.5GB)"
                    
                    // Find the header (h2) for the season
                    const seasonHeader = link.closest('.wp-block-buttons').prevAll('h2.wp-block-heading').first().text().trim(); // "Season 3 ~ English-Hindi-Korean-Tamil-Telugu"
                    
                    if (seasonHeader.includes(seasonIdentifier) && linkText.toLowerCase().includes(qualityIdentifier.toLowerCase())) {
                        episodeBlogLink = link.attr('href');
                        console.log(`  Found matching link for "${quality}": ${episodeBlogLink}`);
                        return false; // Exit the loop
                    }
                });
            }

            if (!episodeBlogLink) {
                 // Fallback to old logic if specific link not found
                console.warn('Could not find a specific quality match, falling back to first available link.');
                episodeBlogLink = $$('a[href*="episodes.modpro.blog"], a[href*="cinematickit.org"]').attr('href');
            }

            if (!episodeBlogLink) {
                console.error('Could not find episodes.modpro.blog or cinematickit.org link on dramadrip page.');
                return [];
            }
            // Now, we call this function again with the new blog link
            return await resolveIntermediateLink(episodeBlogLink, initialUrl, quality);

        } else if (urlObject.hostname.includes('episodes.modpro.blog') || urlObject.hostname.includes('cinematickit.org')) {
            console.log(`\nHandling episodes page link: ${initialUrl}`);
            const { data } = await axios.get(initialUrl, { headers: { 'Referer': refererUrl } });
            const $ = cheerio.load(data);
            const finalLinks = [];
            // This page has the actual driveseed, tech.unblockedgames.world, or tech.creativeexpressionsblog.com links. Ignore the batch button.
            $('.entry-content h3:contains("Episode") a').each((i, el) => {
                const link = $(el).attr('href');
                const text = $(el).text().trim();
                if (link && text && !text.toLowerCase().includes('batch') && (link.includes('driveseed.org') || link.includes('tech.unblockedgames.world') || link.includes('tech.creativeexpressionsblog.com'))) {
                    finalLinks.push({
                        server: text.replace(/\s+/g, ' '), // Clean up text
                        url: link,
                    });
                }
            });
            console.log(`  Found ${finalLinks.length} final links on episodes page.`);
            return finalLinks;

        } else if (urlObject.hostname.includes('modrefer.in')) {
            const encodedUrl = urlObject.searchParams.get('url');
            if (!encodedUrl) {
                console.error('Could not find encoded URL in modrefer.in link.');
                return [];
            }

            const decodedUrl = Buffer.from(encodedUrl, 'base64').toString('utf8');
            console.log(`\nBypassing redirector. Going directly to: ${decodedUrl}`);

            const { data } = await axios.get(decodedUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Referer': refererUrl,
                }
            });

            const $ = cheerio.load(data);

            const finalLinks = [];
            // The links are inside a hidden div, but we can still parse it.
            $('.timed-content-client_show_0_5_0 a').each((i, el) => {
                const link = $(el).attr('href');
                const text = $(el).text().trim();
                if (link) {
                    console.log(`  Found final link: ${text} -> ${link}`);
                    finalLinks.push({
                        server: text,
                        url: link,
                    });
                }
            });
            return finalLinks;
        } else if (urlObject.hostname.includes('tech.unblockedgames.world') || urlObject.hostname.includes('tech.creativeexpressionsblog.com')) {
            console.log(`\nHandling SID link: ${initialUrl}`);
            const driveleechUrl = await resolveTechUnblockedLink(initialUrl);
            if (driveleechUrl) {
                console.log(`  Successfully resolved to driveleech: ${driveleechUrl}`);
                // Return the driveleech URL as a link that can be processed by existing driveleech logic
                return [{
                    server: 'Tech Unblocked -> Driveleech',
                    url: driveleechUrl
                }];
            } else {
                console.error('  Failed to resolve tech.unblockedgames.world link');
                return [];
            }
        } else {
            console.warn(`resolveIntermediateLink does not handle hostname: ${urlObject.hostname}. Returning empty.`);
            return [];
        }
    } catch (error) {
        console.error(`Error resolving intermediate link: ${error.message}`);
        if (error.response) {
            console.error('--- Error Response Data (first 500 chars) ---');
            console.error(String(error.response.data).substring(0, 500));
            console.error('-------------------------------------------');
        }
        return [];
    }
}

// Function to resolve tech.unblockedgames.world links to driveleech URLs (adapted from UHDMovies)
async function resolveTechUnblockedLink(sidUrl) {
  console.log(`[MoviesModChat] Resolving SID link: ${sidUrl}`);
  const { origin } = new URL(sidUrl);
  const jar = new CookieJar();
  const session = wrapper(axios.create({
    jar,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'en-US,en;q=0.5',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
    }
  }));

  try {
    // Step 0: Get the _wp_http value
    console.log("  [SID] Step 0: Fetching initial page...");
    const responseStep0 = await session.get(sidUrl);
    let $ = cheerio.load(responseStep0.data);
    const initialForm = $('#landing');
    const wp_http_step1 = initialForm.find('input[name="_wp_http"]').val();
    const action_url_step1 = initialForm.attr('action');

    if (!wp_http_step1 || !action_url_step1) {
      console.error("  [SID] Error: Could not find _wp_http in initial form.");
      return null;
    }

    // Step 1: POST to the first form's action URL
    console.log("  [SID] Step 1: Submitting initial form...");
    const step1Data = new URLSearchParams({ '_wp_http': wp_http_step1 });
    const responseStep1 = await session.post(action_url_step1, step1Data, {
      headers: { 'Referer': sidUrl, 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    // Step 2: Parse verification page for second form
    console.log("  [SID] Step 2: Parsing verification page...");
    $ = cheerio.load(responseStep1.data);
    const verificationForm = $('#landing');
    const action_url_step2 = verificationForm.attr('action');
    const wp_http2 = verificationForm.find('input[name="_wp_http2"]').val();
    const token = verificationForm.find('input[name="token"]').val();

    if (!action_url_step2) {
      console.error("  [SID] Error: Could not find verification form.");
      return null;
    }

    // Step 3: POST to the verification URL
    console.log("  [SID] Step 3: Submitting verification...");
    const step2Data = new URLSearchParams({ '_wp_http2': wp_http2, 'token': token });
    const responseStep2 = await session.post(action_url_step2, step2Data, {
      headers: { 'Referer': responseStep1.request.res.responseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    // Step 4: Find dynamic cookie and link from JavaScript
    console.log("  [SID] Step 4: Parsing final page for JS data...");
    let finalLinkPath = null;
    let cookieName = null;
    let cookieValue = null;

    const scriptContent = responseStep2.data;
    const cookieMatch = scriptContent.match(/s_343\('([^']+)',\s*'([^']+)'/);
    const linkMatch = scriptContent.match(/c\.setAttribute\("href",\s*"([^"]+)"\)/);
    
    if (cookieMatch) {
      cookieName = cookieMatch[1].trim();
      cookieValue = cookieMatch[2].trim();
    }
    if (linkMatch) {
      finalLinkPath = linkMatch[1].trim();
    }

    if (!finalLinkPath || !cookieName || !cookieValue) {
      console.error("  [SID] Error: Could not extract dynamic cookie/link from JS.");
      return null;
    }
    
    const finalUrl = new URL(finalLinkPath, origin).href;
    console.log(`  [SID] Dynamic link found: ${finalUrl}`);
    console.log(`  [SID] Dynamic cookie found: ${cookieName}`);

    // Step 5: Set cookie and make final request
    console.log("  [SID] Step 5: Setting cookie and making final request...");
    await jar.setCookie(`${cookieName}=${cookieValue}`, origin);
    
    const finalResponse = await session.get(finalUrl, {
      headers: { 'Referer': responseStep2.request.res.responseUrl }
    });

    // Step 6: Extract driveleech URL from meta refresh tag
    $ = cheerio.load(finalResponse.data);
    const metaRefresh = $('meta[http-equiv="refresh"]');
    if (metaRefresh.length > 0) {
        const content = metaRefresh.attr('content');
        const urlMatch = content.match(/url=(.*)/i);
        if (urlMatch && urlMatch[1]) {
            const driveleechUrl = urlMatch[1].replace(/"/g, "").replace(/'/g, "");
            console.log(`  [SID] SUCCESS! Resolved Driveleech URL: ${driveleechUrl}`);
            return driveleechUrl;
        }
    }

    console.error("  [SID] Error: Could not find meta refresh tag with Driveleech URL.");
    return null;

  } catch (error) {
    console.error(`  [SID] Error during SID resolution: ${error.message}`);
    if (error.response) {
      console.error(`  [SID] Status: ${error.response.status}`);
    }
    return null;
  }
}

// This function resolves the driveseed.org page to get the final video link.
async function resolveDriveseedLink(driveseedUrl) {
    try {
        console.log(`\nResolving Driveseed link step 1: ${driveseedUrl}`);
        const { data } = await axios.get(driveseedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Referer': 'https://links.modpro.blog/', // Generic referer
            }
        });

        const redirectMatch = data.match(/window\.location\.replace\("([^"]+)"\)/);

        if (redirectMatch && redirectMatch[1]) {
            const finalPath = redirectMatch[1];
            const finalUrl = `https://driveseed.org${finalPath}`;
            console.log(`  JS redirect found. Following to: ${finalUrl}`);
            
            // Make the second request to the actual final page
            const finalResponse = await axios.get(finalUrl, {
                 headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Referer': driveseedUrl,
                }
            });
            const finalData = finalResponse.data;

            const $ = cheerio.load(finalData);
            
            const downloadOptions = [];

            // Find the 'Instant Download' button (leads to video-seed.pro)
            const instantDownloadLink = $('a:contains("Instant Download")').attr('href');
            if (instantDownloadLink) {
                console.log(`  Found Instant Download option: ${instantDownloadLink}`);
                downloadOptions.push({
                    title: 'Instant Download',
                    type: 'instant',
                    url: instantDownloadLink,
                });
            }

            // Find the 'Resume Cloud' button (leads to /zfile/...)
            const resumeCloudLink = $('a:contains("Resume Cloud")').attr('href');
            if (resumeCloudLink) {
                const fullResumeCloudUrl = `https://driveseed.org${resumeCloudLink}`;
                console.log(`  Found Resume Cloud option: ${fullResumeCloudUrl}`);
                 downloadOptions.push({
                    title: 'Resume Cloud',
                    type: 'resume',
                    url: fullResumeCloudUrl,
                });
            }

            // Find the 'Resume Worker Bot' button
            const workerSeedLink = $('a:contains("Resume Worker Bot")').attr('href');
            if(workerSeedLink) {
                 console.log(`  Found Resume Worker Bot option: ${workerSeedLink}`);
                 downloadOptions.push({
                    title: 'Resume Worker Bot',
                    type: 'worker',
                    url: workerSeedLink,
                });
            }

            if (downloadOptions.length > 0) {
                return downloadOptions;
            } else {
                console.log('  Could not find any download options on the final page.');
                return null;
            }
        } else {
             console.log('  No JS redirect found on initial Driveseed page.');
             return null;
        }

    } catch (error) {
        console.error(`Error resolving Driveseed link: ${error.message}`);
        return null;
    }
}

// This function handles the Resume Cloud link path.
async function resolveResumeCloudLink(resumeUrl) {
    try {
        console.log(`\nResolving Resume Cloud link: ${resumeUrl}`);
        const { data } = await axios.get(resumeUrl, {
             headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Referer': 'https://driveseed.org/',
            }
        });
        const $ = cheerio.load(data);

        const downloadLink = $('a:contains("Cloud Resume Download")').attr('href');

        if (downloadLink) {
            console.log(`  SUCCESS! Final video link from Resume Cloud: ${downloadLink}`);
            return downloadLink;
        } else {
            console.log('  Could not find the "Cloud Resume Download" link.');
            return null;
        }
    } catch (error) {
        console.error(`Error resolving Resume Cloud link: ${error.message}`);
        return null;
    }
}

// This function handles the workerseed.dev link path.
async function resolveWorkerSeedLink(workerSeedUrl) {
    try {
        console.log(`\nResolving Worker-seed link: ${workerSeedUrl}`);

        // Create a session-aware axios instance
        const jar = new CookieJar();
        const session = wrapper(axios.create({ jar }));

        // Step 1: GET the page to get the script content and cookies
        console.log('  Step 1: Fetching page to get script content and cookies...');
        const { data: pageHtml } = await session.get(workerSeedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            }
        });

        // Step 2: Use regex to extract the token and the correct ID from the script
        const scriptContent = pageHtml.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/g)
            .find(s => s.includes("formData.append('token'"));

        if (!scriptContent) {
            console.error('  Could not find the relevant script tag on the page.');
            return null;
        }

        const tokenMatch = scriptContent.match(/formData\.append\('token', '([^']+)'\)/);
        const idMatch = scriptContent.match(/fetch\('\/download\?id=([^']+)',/);

        if (!tokenMatch || !tokenMatch[1] || !idMatch || !idMatch[1]) {
            console.error('  Could not extract token or correct ID from the script.');
            return null;
        }

        const token = tokenMatch[1];
        const correctId = idMatch[1];
        console.log(`  Step 2: Extracted token: ${token}`);
        console.log(`  Step 2: Extracted correct ID: ${correctId}`);

        // Step 3: Make the POST request with the correct data using the same session
        const apiUrl = `https://workerseed.dev/download?id=${correctId}`;
        
        const formData = new FormData();
        formData.append('token', token);
       
        console.log(`  Step 3: POSTing to endpoint: ${apiUrl} with extracted token.`);

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
            console.log(`  SUCCESS! Final video link from Worker-seed API: ${apiResponse.url}`);
            return apiResponse.url;
        } else {
            console.log('  Worker-seed API did not return a URL. Full response:');
            console.log(apiResponse);
            return null;
        }
    } catch (error) {
        console.error(`Error resolving Worker-seed link: ${error.message}`);
        if (error.response) {
            console.error('Error response data:', error.response.data);
        }
        return null;
    }
}

// This function handles the final video-seed.pro page.
async function resolveVideoSeedLink(videoSeedUrl) {
    try {
        console.log(`\nResolving Video-seed link: ${videoSeedUrl}`);
        const urlObject = new URL(videoSeedUrl);
        const keysParam = urlObject.searchParams.get('url');

        if (!keysParam) {
            console.error('Could not find the "url" parameter in the video-seed.pro link.');
            return null;
        }

        const apiUrl = 'https://video-seed.pro/api';
        console.log(`  POSTing to API endpoint: ${apiUrl}`);

        // Simulate the API call made by the page's javascript
        const { data } = await axios.post(apiUrl, `keys=${keysParam}`, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'x-token': 'video-seed.pro'
            }
        });

        // The response from the API should be JSON with a 'url' property
        if (data && data.url) {
            console.log(`  SUCCESS! Final video link from API: ${data.url}`);
            return data.url;
        } else {
            console.log('  API request did not return a valid link object.');
            console.log('  Received:', data);
            return null;
        }
    } catch (error) {
        console.error(`Error resolving Video-seed link: ${error.message}`);
        return null;
    }
}

// Function to prompt user for selection
function promptUser(results, promptTitle) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        console.log(`\nPlease select a ${promptTitle}:`);
        results.forEach((result, index) => {
            // Flexible display text: uses title, quality, or server property
            const displayText = result.title || result.quality || result.server;
            console.log(`${index + 1}: ${displayText}`);
        });
        console.log('0: Exit');

        rl.question('\nEnter your choice: ', (choice) => {
            rl.close();
            const index = parseInt(choice, 10) - 1;
            if (index >= 0 && index < results.length) {
                resolve(results[index]);
            } else {
                resolve(null); // Exit or invalid choice
            }
        });
    });
}

// Main function to run the scraper from the command line.
async function main() {
    const query = process.argv[2];
    if (!query) {
        console.log('Please provide a search query.');
        console.log('Usage: node moviesmod_scraper.js "Your Movie Title"');
        return;
    }

    console.log(`Searching for "${query}"...`);
    const results = await searchMovies(query);

    if (results.length === 0) {
        return;
    }

    const selectedMovie = await promptUser(results, 'movie to scrape');

    if (!selectedMovie) {
        console.log('Exiting.');
        return;
    }

    const downloadPages = await extractDownloadLinks(selectedMovie.url);

    if (downloadPages.length === 0) {
        console.log('No download pages found.');
        return;
    }

    // --- New logic to ask about batch files ---
    let finalDownloadPages = downloadPages; // Default to all links
    const hasBatchLinks = downloadPages.some(page => page.quality.toLowerCase().includes('batch/zip'));

    if (hasBatchLinks) {
        const includeBatch = await new Promise((resolve) => {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });
            rl.question('\nThis page contains Batch/Zip files. Include them in the list? (yes/no): ', (answer) => {
                rl.close();
                resolve(answer.toLowerCase().trim().startsWith('y'));
            });
        });

        if (!includeBatch) {
            finalDownloadPages = downloadPages.filter(page => !page.quality.toLowerCase().includes('batch/zip'));
            console.log('Filtered out Batch/Zip files.');
        }
    }
    // --- End of new logic ---

    console.log('\n--- Found Downloadable Qualities ---');
    const selectedQuality = await promptUser(finalDownloadPages, 'quality to download');

    if (!selectedQuality) {
        console.log('Exiting.');
        return;
    }

    console.log(`Selected Quality: ${selectedQuality.quality}`);

    // Resolve the link from modrefer.in (or now dramadrip) to the next page
    const finalLinks = await resolveIntermediateLink(selectedQuality.url, selectedMovie.url, selectedQuality.quality);

    if (finalLinks.length > 0) {
        console.log('\n--- Found Downloadable Items ---');

        // --- New Logic to handle either episodes or server list ---
        const isEpisodeList = finalLinks.every(link => link.server && link.server.toLowerCase().startsWith('episode'));
        
        let targetLink = null;

        if (isEpisodeList) {
            console.log('Detected a list of episodes.');
            const selectedEpisode = await promptUser(finalLinks, 'episode');
            if (selectedEpisode) {
                targetLink = selectedEpisode.url;
            }
        } else {
            console.log('Detected a list of servers.');
            const fastServerLink = finalLinks.find(link => link.server.includes('Fast Server'));
            if (fastServerLink) {
                 console.log(`Automatically selected server: "${fastServerLink.server}"`);
                 targetLink = fastServerLink.url;
            } else {
                 console.log('Could not find "Fast Server" link. Exiting.');
            }
        }

        if (targetLink) {
             if (targetLink.includes('tech.unblockedgames.world') || targetLink.includes('tech.creativeexpressionsblog.com')) {
                console.log('\n--- Processing SID Link ---');
                const driveleechUrl = await resolveTechUnblockedLink(targetLink);
                if (driveleechUrl) {
                    console.log('✅ Successfully bypassed tech.unblockedgames.world!');
                    console.log(`🔄 Continuing with resolved URL: ${driveleechUrl}`);
                    
                    // Continue processing the resolved URL (which is usually driveseed.org)
                    targetLink = driveleechUrl;
                } else {
                    console.log('❌ Failed to bypass tech.unblockedgames.world link.');
                    return; // Exit if bypass failed
                }
            }
            
            if (targetLink.includes('driveseed.org')) {
                const downloadOptions = await resolveDriveseedLink(targetLink);
                
                if (downloadOptions && downloadOptions.length > 0) {
                    console.log('\n--- Found Download Methods ---');
                    const selectedMethod = await promptUser(downloadOptions, 'download method');

                    if (!selectedMethod) {
                        console.log('Exiting.');
                        return;
                    }

                    if (selectedMethod.type === 'instant') {
                        const finalVideoLink = await resolveVideoSeedLink(selectedMethod.url);
                        if (finalVideoLink) {
                            console.log('\n================================');
                            console.log('✅ Final Download Link Found:');
                            console.log(finalVideoLink);
                            console.log('================================');
                        } else {
                            console.log('Failed to get the final video link from Video-seed.');
                        }
                    } else if (selectedMethod.type === 'resume') {
                        const finalVideoLink = await resolveResumeCloudLink(selectedMethod.url);
                        if (finalVideoLink) {
                            console.log('\n================================');
                            console.log('✅ Final Download Link Found:');
                            console.log(finalVideoLink);
                            console.log('================================');
                        } else {
                            console.log('Failed to get the final video link from Resume Cloud.');
                        }
                    } else if (selectedMethod.type === 'worker') {
                        const finalVideoLink = await resolveWorkerSeedLink(selectedMethod.url);
                        if (finalVideoLink) {
                            console.log('\n================================');
                            console.log('✅ Final Download Link Found:');
                            console.log(finalVideoLink);
                            console.log('================================');
                        } else {
                            console.log('Failed to get the final video link from Worker-seed.');
                        }
                    }
                } else {
                    console.log('Failed to get download options from Driveseed.');
                }
            } else if (targetLink.includes('driveleech.net')) {
                console.log('\n--- Processing Driveleech Link ---');
                console.log('Driveleech links from tech.unblockedgames.world bypass are not yet supported in this scraper.');
                console.log('The bypassed link is:');
                console.log(targetLink);
                console.log('\nYou can manually download from this Driveleech URL.');
            } else {
                console.log(`This scraper currently supports Driveseed.org and Driveleech.net links. Support for this link can be added: ${targetLink}`);
            }
        } else {
            console.log('No item selected or found. Exiting.');
        }
        // --- End of new logic ---

    } else {
        console.log('Could not resolve the modrefer.in link.');
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    searchMovies,
    extractDownloadLinks,
}; 