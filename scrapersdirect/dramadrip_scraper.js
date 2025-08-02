const axios = require('axios');
const cheerio = require('cheerio');
const readline = require('readline');
const FormData = require('form-data');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const { URLSearchParams, URL } = require('url');

// Search function for dramadrip.com
async function searchDramaDrip(query) {
    try {
        const searchUrl = `https://dramadrip.com/?s=${encodeURIComponent(query)}`;
        console.log(`Searching DramaDrip for: "${query}"`);
        const { data } = await axios.get(searchUrl);
        const $ = cheerio.load(data);
        const results = [];

        // Search results are in h2 tags with a link inside
        $('h2.entry-title a').each((i, element) => {
            const linkElement = $(element);
            const title = linkElement.text().trim();
            const url = linkElement.attr('href');
            if (title && url) {
                results.push({ title, url });
            }
        });

        console.log(`Found ${results.length} results.`);
        return results;
    } catch (error) {
        console.error(`Error searching on DramaDrip: ${error.message}`);
        return [];
    }
}

// This function extracts the download links from a dramadrip.com page
async function extractDramaDripLinks(url) {
    try {
        console.log(`\nExtracting links from: ${url}`);
        const { data } = await axios.get(url);
        const $ = cheerio.load(data);
        
        // Check for TV show season headers first
        const seasonHeaders = $('h2.wp-block-heading:contains("Season")');
        if (seasonHeaders.length > 0) {
            console.log('TV show detected. Extracting seasons...');
            const seasons = [];
            seasonHeaders.each((i, el) => {
                const header = $(el);
                const headerText = header.text().trim();
                const seasonInfo = { seasonTitle: headerText, qualities: [] };
                const buttonContainer = header.next('.wp-block-buttons');
                if (buttonContainer.length > 0) {
                    buttonContainer.find('a').each((j, linkEl) => {
                        const link = $(linkEl);
                        const qualityText = link.text().trim();
                        const linkUrl = link.attr('href');
                        if (linkUrl && !qualityText.toLowerCase().includes('zip')) {
                            seasonInfo.qualities.push({ quality: qualityText, url: linkUrl });
                        }
                    });
                }
                seasons.push(seasonInfo);
            });
            console.log(`Found ${seasons.length} seasons.`);
            return { type: 'tv', data: seasons };
        }

        // If no season headers, assume it's a movie
        console.log('Movie detected. Extracting download qualities...');
        const qualities = [];
        // For movies, links are usually inside a spoiler
        $('.su-spoiler-content .wp-block-button a').each((i, el) => {
            const link = $(el);
            const qualityText = link.text().trim();
            const linkUrl = link.attr('href');
            if (linkUrl) {
                qualities.push({
                    quality: qualityText,
                    url: linkUrl
                });
            }
        });

        if (qualities.length > 0) {
             console.log(`Found ${qualities.length} download qualities for the movie.`);
             return { type: 'movie', data: qualities };
        }

        console.log('Could not find any TV seasons or movie download links.');
        return null;

    } catch (error) {
        console.error(`Error extracting from DramaDrip: ${error.message}`);
        return null;
    }
}

// Renamed and adapted to handle both movies and TV shows
async function resolveIntermediateLink(initialUrl, refererUrl) {
    try {
        const urlObject = new URL(initialUrl);

        if (urlObject.hostname.includes('episodes.modpro.blog') || urlObject.hostname.includes('cinematickit.org')) {
            console.log(`\nHandling intermediate link: ${initialUrl}`);
            const { data } = await axios.get(initialUrl, { headers: { 'Referer': refererUrl } });
            const $ = cheerio.load(data);
            const finalLinks = [];

            // Try TV show selector first (episodes)
            let episodeLinks = $('.entry-content h3:contains("Episode") a');
            if (episodeLinks.length > 0) {
                 console.log('  Detected TV Show episode list (modpro.blog style).');
                 episodeLinks.each((i, el) => {
                    const link = $(el).attr('href');
                    const text = $(el).text().trim();
                    const supportedLink = link && (link.includes('driveseed.org') || link.includes('tech.unblockedgames.world') || link.includes('tech.creativeexpressionsblog.com'));

                    if (supportedLink && text && !text.toLowerCase().includes('batch') && !text.toLowerCase().includes('zip')) {
                        finalLinks.push({
                            type: 'episode',
                            name: text.replace(/\s+/g, ' '),
                            url: link,
                        });
                    }
                });
                return { type: 'episodes', links: finalLinks };
            }
            
            // Try another TV show selector (cinematickit.org style)
            let seriesBtnLinks = $('.wp-block-button.series_btn a');
            if (seriesBtnLinks.length > 0) {
                console.log('  Detected TV Show episode list (cinematickit.org style).');
                seriesBtnLinks.each((i, el) => {
                    const link = $(el).attr('href');
                    const text = $(el).text().trim();
                    const supportedLink = link && (link.includes('driveseed.org') || link.includes('tech.unblockedgames.world') || link.includes('tech.creativeexpressionsblog.com'));

                    if (supportedLink && text && !text.toLowerCase().includes('batch') && !text.toLowerCase().includes('zip')) {
                        finalLinks.push({
                            type: 'episode',
                            name: text.replace(/\s+/g, ' '),
                            url: link,
                        });
                    }
                });
                return { type: 'episodes', links: finalLinks };
            }
            
            // Fallback to movie selector (servers)
            console.log('  No episode lists found, assuming it is a movie and looking for server links...');
            $('.timed-content-client_show_0_5_0 a, .timed-content-client_show_0_7_0 .series_btn a, .wp-block-button.movie_btn a').each((i, el) => {
                 const link = $(el).attr('href');
                 const text = $(el).text().trim();
                 const supportedLink = link && (link.includes('driveseed.org') || link.includes('tech.unblockedgames.world') || link.includes('tech.creativeexpressionsblog.com'));

                 if (supportedLink && text) {
                     finalLinks.push({
                         type: 'server',
                         name: text,
                         url: link
                     });
                 }
            });

            if (finalLinks.length > 0) {
                return { type: 'servers', links: finalLinks };
            }
        }
        
        console.warn(`resolveIntermediateLink does not handle hostname: ${urlObject.hostname}.`);
        return null;

    } catch (error) {
        console.error(`Error resolving intermediate link: ${error.message}`);
        return null;
    }
}

// Copied and adapted from moviesmod_scraper.js
async function resolveTechUnblockedLink(sidUrl) {
  console.log(`[DramaDrip] Resolving SID link: ${sidUrl}`);
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

// Copied from moviesmod_scraper.js
async function resolveDriveseedLink(driveseedUrl) {
    try {
        console.log(`\nResolving Driveseed link step 1: ${driveseedUrl}`);
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
            console.log(`  JS redirect found. Following to: ${finalUrl}`);
            
            const finalResponse = await axios.get(finalUrl, {
                 headers: { 'Referer': driveseedUrl }
            });
            const $ = cheerio.load(finalResponse.data);
            
            const downloadOptions = [];
            $('a:contains("Instant Download"), a:contains("Resume Cloud"), a:contains("Resume Worker Bot")').each((i, el) => {
                const button = $(el);
                const title = button.text().trim();
                let type = 'unknown';
                if (title.includes('Instant')) type = 'instant';
                if (title.includes('Resume Cloud')) type = 'resume';
                if (title.includes('Worker Bot')) type = 'worker';

                let url = button.attr('href');
                if (type === 'resume' && !url.startsWith('http')) {
                    url = `https://driveseed.org${url}`;
                }

                downloadOptions.push({ title, type, url });
            });

            return downloadOptions.length > 0 ? downloadOptions : null;
        }
        return null;
    } catch (error) {
        console.error(`Error resolving Driveseed link: ${error.message}`);
        return null;
    }
}

// Copied from moviesmod_scraper.js
async function resolveFinalLink(downloadOption) {
    switch (downloadOption.type) {
        case 'instant':
            console.log(`\nResolving Instant Download: ${downloadOption.url}`);
            const urlObject = new URL(downloadOption.url);
            const keysParam = urlObject.searchParams.get('url');
            if (!keysParam) return null;

            const { data } = await axios.post('https://video-seed.pro/api', `keys=${keysParam}`, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-token': 'video-seed.pro' }
            });
            return data && data.url ? data.url : null;

        case 'resume':
            console.log(`\nResolving Resume Cloud: ${downloadOption.url}`);
            const { data: resumeData } = await axios.get(downloadOption.url, { headers: { 'Referer': 'https://driveseed.org/' } });
            const $ = cheerio.load(resumeData);
            return $('a:contains("Cloud Resume Download")').attr('href') || null;

        case 'worker':
             console.log(`\nResolving Worker-seed: ${downloadOption.url}`);
            const jar = new CookieJar();
            const session = wrapper(axios.create({ jar }));
            const { data: pageHtml } = await session.get(downloadOption.url);
            
            const scriptContent = pageHtml.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/g).find(s => s.includes("formData.append('token'"));
            if (!scriptContent) return null;

            const tokenMatch = scriptContent.match(/formData\.append\('token', '([^']+)'\)/);
            const idMatch = scriptContent.match(/fetch\('\/download\?id=([^']+)',/);
            if (!tokenMatch || !idMatch) return null;

            const formData = new FormData();
            formData.append('token', tokenMatch[1]);
            
            const apiUrl = `https://workerseed.dev/download?id=${idMatch[1]}`;
            const { data: apiResponse } = await session.post(apiUrl, formData, { headers: { ...formData.getHeaders(), 'x-requested-with': 'XMLHttpRequest' } });
            return apiResponse && apiResponse.url ? apiResponse.url : null;
            
        default:
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
            const displayText = result.seasonTitle || result.quality || result.episode || result.title;
            console.log(`${index + 1}: ${displayText}`);
        });
        console.log('0: Exit');

        rl.question('Enter your choice: ', (choice) => {
            rl.close();
            const index = parseInt(choice, 10) - 1;
            resolve((index >= 0 && index < results.length) ? results[index] : null);
        });
    });
}

// Main function to run the scraper
async function main() {
    const query = process.argv[2];
    if (!query) {
        console.log('Please provide a search query.');
        console.log('Usage: node dramadrip_scraper.js "Your Drama Name"');
        return;
    }

    console.log(`Searching for "${query}"...`);
    const searchResults = await searchDramaDrip(query);
    if (searchResults.length === 0) return;

    const selectedDrama = await promptUser(searchResults, 'content to scrape');
    if (!selectedDrama) return console.log('Exiting.');

    console.log(`Scraping "${selectedDrama.title}"...`);
    const extractedContent = await extractDramaDripLinks(selectedDrama.url);
    if (!extractedContent || extractedContent.data.length === 0) {
        console.log('Could not find any content on the page.');
        return;
    }

    let qualityUrl;
    // Handle TV shows
    if (extractedContent.type === 'tv') {
        const selectedSeason = await promptUser(extractedContent.data, 'season');
        if (!selectedSeason) return console.log('Exiting.');
        const selectedQuality = await promptUser(selectedSeason.qualities, 'quality');
        if (!selectedQuality) return console.log('Exiting.');
        qualityUrl = selectedQuality.url;
    } 
    // Handle Movies
    else if (extractedContent.type === 'movie') {
        const selectedQuality = await promptUser(extractedContent.data, 'quality');
        if (!selectedQuality) return console.log('Exiting.');
        qualityUrl = selectedQuality.url;
    }

    if (!qualityUrl) {
        console.log('Could not determine quality URL.');
        return;
    }

    const intermediateResult = await resolveIntermediateLink(qualityUrl, selectedDrama.url);
    if (!intermediateResult || intermediateResult.links.length === 0) {
         console.log('Could not find links on the intermediate page.');
         return;
    }

    let targetUrl;

    if (intermediateResult.type === 'episodes') {
        const episodeLinks = intermediateResult.links.map(l => ({ episode: l.name, url: l.url }));
        const selectedEpisode = await promptUser(episodeLinks, 'episode');
        if (!selectedEpisode) return console.log('Exiting.');
        targetUrl = selectedEpisode.url;
    } else if (intermediateResult.type === 'servers') {
        const serverLinks = intermediateResult.links.map(l => ({ title: l.name, url: l.url }));
        console.log('Detected a list of servers.');
        // Prefer "Fast Server" but take the first available if not found
        const fastServer = serverLinks.find(s => s.title.includes('Fast Server'));
        if (fastServer) {
            console.log(`Automatically selected server: "${fastServer.title}"`);
            targetUrl = fastServer.url;
        } else {
            console.log(`Automatically selecting first server: "${serverLinks[0].title}"`);
            targetUrl = serverLinks[0].url;
        }
    }

    if (!targetUrl) {
        console.log('Could not determine target URL.');
        return;
    }

    // Handle SID links first
    if (targetUrl.includes('tech.unblockedgames.world') || targetUrl.includes('tech.creativeexpressionsblog.com')) {
        console.log(`\nBypassing SID link: ${targetUrl}`);
        const resolvedUrl = await resolveTechUnblockedLink(targetUrl);
        if (resolvedUrl) {
            console.log(`✅ Successfully bypassed SID. Continuing with: ${resolvedUrl}`);
            targetUrl = resolvedUrl;
        } else {
            console.log(`❌ Failed to bypass SID link.`);
            return;
        }
    }

    // Now, process the (potentially resolved) driveseed link
    if (targetUrl && targetUrl.includes('driveseed.org')) {
        const downloadOptions = await resolveDriveseedLink(targetUrl);
        if (!downloadOptions || downloadOptions.length === 0) {
            return console.log('Could not find download options.');
        }

        // Automatically select download method based on priority
        let selectedMethod = null;
        const resumeCloud = downloadOptions.find(opt => opt.type === 'resume');
        const workerBot = downloadOptions.find(opt => opt.type === 'worker');
        const instantDownload = downloadOptions.find(opt => opt.type === 'instant');

        if (resumeCloud) {
            console.log('\nAutomatically selected download method: Resume Cloud');
            selectedMethod = resumeCloud;
        } else if (workerBot) {
            console.log('\nAutomatically selected download method: Resume Worker Bot');
            selectedMethod = workerBot;
        } else if (instantDownload) {
            console.log('\nAutomatically selected download method: Instant Download');
            selectedMethod = instantDownload;
        }

        if (!selectedMethod) {
            console.log('No suitable download method found (Resume Cloud, Worker Bot, or Instant Download).');
            return;
        }
        
        const finalLink = await resolveFinalLink(selectedMethod);
        if (finalLink) {
            console.log('\n================================');
            console.log('✅ Final Download Link Found:');
            console.log(finalLink);
            console.log('================================');
        } else {
            console.log('❌ Failed to get the final video link.');
        }
    } else {
        console.log(`Unsupported link type. Cannot process: ${targetUrl}`);
    }
}

if (require.main === module) {
    main();
} 