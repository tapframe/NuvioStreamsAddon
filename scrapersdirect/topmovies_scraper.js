const axios = require('axios');
const cheerio = require('cheerio');
const readline = require('readline');
const FormData = require('form-data');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const { URLSearchParams, URL } = require('url');

const BASE_URL = 'https://topmovies.rodeo';

// Configure axios with headers to mimic a browser
const axiosInstance = axios.create({
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0'
    },
    timeout: 45000
});

// Search function for topmovies.rodeo
async function searchMovies(query) {
    try {
        const searchUrl = `${BASE_URL}/search/${encodeURIComponent(query)}`;
        console.log(`Searching: ${searchUrl}`);
        
        const { data } = await axiosInstance.get(searchUrl);
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
        console.error(`Error searching on TopMovies: ${error.message}`);
        return [];
    }
}

// Extract download links from movie page
async function extractDownloadLinks(moviePageUrl) {
    try {
        console.log(`\nExtracting download links from: ${moviePageUrl}`);
        const { data } = await axiosInstance.get(moviePageUrl);
        const $ = cheerio.load(data);
        
        const links = [];
        const movieTitle = $('h1').first().text().trim();

        // Find all download quality sections and their corresponding leechpro.blog links
        $('h3').each((i, element) => {
            const header = $(element);
            const headerText = header.text().trim();
            
            // Look for quality indicators in headers
            if (headerText.toLowerCase().includes('download') && 
                (headerText.includes('480p') || headerText.includes('720p') || headerText.includes('1080p') || headerText.includes('4K'))) {
                
                // Find the download link in the IMMEDIATE next element
                const linkElement = header.next().find('a[href*="leechpro.blog"]');
                
                if (linkElement.length > 0) {
                    const link = linkElement.attr('href');
                    let quality = 'Unknown Quality';
                    
                    // Extract quality from header text
                    const qualityMatch = headerText.match(/(480p|720p|1080p|4K|2160p).*?(\[[^\]]+\])?/i);
                    if (qualityMatch) {
                        quality = qualityMatch[0].replace(/download.*?movie\s+/i, '').trim();
                    }
                    
                    // Check for duplicates by both URL and quality
                    if (link && !links.some(item => item.url === link || item.quality === quality)) {
                        links.push({
                            quality: quality,
                            url: link
                        });
                    }
                }
            }
        });

        console.log(`Found ${links.length} download qualities`);
        return {
            title: movieTitle,
            links: links
        };
    } catch (error) {
        console.error(`Error extracting download links: ${error.message}`);
        return { title: 'Unknown', links: [] };
    }
}

// Resolve leechpro.blog page to get tech.unblockedgames.world link
async function resolveLeechproLink(leechproUrl) {
    try {
        console.log(`\nResolving Leechpro link: ${leechproUrl}`);
        const { data } = await axiosInstance.get(leechproUrl);
        const $ = cheerio.load(data);

        // Look for any of our supported link types in the timed content section first
        let resolvedLink = null;
        
        const timedContent = $('.timed-content-client_show_0_5_0');
        if (timedContent.length > 0) {
            const supportedLink = timedContent.find('a[href*="tech.unblockedgames.world"], a[href*="tech.creativeexpressionsblog.com"], a[href*="driveseed.org"], a[href*="driveleech.net"]').first();
            if (supportedLink.length > 0) {
                resolvedLink = supportedLink.attr('href');
            }
        }

        // Fallback: look anywhere on the page for the links
        if (!resolvedLink) {
            const allSupportedLinks = $('a[href*="tech.unblockedgames.world"], a[href*="tech.creativeexpressionsblog.com"], a[href*="driveseed.org"], a[href*="driveleech.net"]');
            if (allSupportedLinks.length > 0) {
                resolvedLink = allSupportedLinks.first().attr('href');
            }
        }

        if (resolvedLink) {
            console.log(`  Found intermediate link: ${resolvedLink}`);
            return resolvedLink;
        } else {
            console.log('  Could not find a supported intermediate link (driveseed, driveleech, or tech.*) on leechpro page');
            return null;
        }
    } catch (error) {
        console.error(`Error resolving leechpro link: ${error.message}`);
        return null;
    }
}

// Copy of the tech.unblockedgames.world bypass from uhdmovies scraper
async function resolveSidToDriveleech(sidUrl) {
    console.log(`Resolving SID link: ${sidUrl}`);
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
        return null;
    }
}

// Function to try Instant Download method
async function tryInstantDownload($) {
    const instantDownloadLink = $('a:contains("Instant Download")').attr('href');
    if (!instantDownloadLink) {
        console.log('  [LOG] No "Instant Download" button found.');
        return null;
    }

    console.log('  Found "Instant Download" link, attempting to extract final URL...');
    
    try {
        const urlParams = new URLSearchParams(new URL(instantDownloadLink).search);
        const keys = urlParams.get('url');

        if (keys) {
            const apiUrl = `${new URL(instantDownloadLink).origin}/api`;
            const formData = new FormData();
            formData.append('keys', keys);

            const apiResponse = await axiosInstance.post(apiUrl, formData, {
                headers: {
                    ...formData.getHeaders(),
                    'x-token': new URL(instantDownloadLink).hostname
                }
            });

            if (apiResponse.data && apiResponse.data.url) {
                let finalUrl = apiResponse.data.url;
                // Fix spaces in workers.dev URLs
                if (finalUrl.includes('workers.dev')) {
                    const urlParts = finalUrl.split('/');
                    const filename = urlParts[urlParts.length - 1];
                    const encodedFilename = filename.replace(/ /g, '%20');
                    urlParts[urlParts.length - 1] = encodedFilename;
                    finalUrl = urlParts.join('/');
                }
                console.log('  Extracted final link from Instant Download API:', finalUrl);
                return finalUrl;
            }
        }
        
        console.log('  Could not find a valid final download link from Instant Download.');
        return null;
    } catch (error) {
        console.log(`  Error processing "Instant Download": ${error.message}`);
        return null;
    }
}

// Function to try Resume Cloud method
async function tryResumeCloud($) {
    const resumeCloudButton = $('a:contains("Resume Cloud"), a:contains("Cloud Resume Download")');
    
    if (resumeCloudButton.length === 0) {
        console.log('  [LOG] No "Resume Cloud" or "Cloud Resume Download" button found.');
        return null;
    }

    const resumeLink = resumeCloudButton.attr('href');
    if (!resumeLink) {
        console.log('  [LOG] Resume Cloud button found but no href attribute.');
        return null;
    }

    // Check if it's already a direct download link (workers.dev)
    if (resumeLink.includes('workers.dev') || resumeLink.startsWith('http')) {
        let directLink = resumeLink;
        // Fix spaces in workers.dev URLs
        if (directLink.includes('workers.dev')) {
            const urlParts = directLink.split('/');
            const filename = urlParts[urlParts.length - 1];
            const encodedFilename = filename.replace(/ /g, '%20');
            urlParts[urlParts.length - 1] = encodedFilename;
            directLink = urlParts.join('/');
        }
        console.log(`  [LOG] Found direct "Cloud Resume Download" link: ${directLink}`);
        return directLink;
    }

    // Otherwise, follow the link to get the final download
    try {
        const resumeUrl = new URL(resumeLink, 'https://driveleech.net').href;
        console.log(`  [LOG] Found 'Resume Cloud' page link. Following to: ${resumeUrl}`);
        
        const finalPageResponse = await axiosInstance.get(resumeUrl, { maxRedirects: 10 });
        const $$ = cheerio.load(finalPageResponse.data);

        // Corrected Selector: Look for the "Cloud Resume Download" button directly
        let finalDownloadLink = $$('a.btn-success:contains("Cloud Resume Download")').attr('href');

        if (finalDownloadLink) {
            // Fix spaces in workers.dev URLs
            if (finalDownloadLink.includes('workers.dev')) {
                const urlParts = finalDownloadLink.split('/');
                const filename = urlParts[urlParts.length - 1];
                const encodedFilename = filename.replace(/ /g, '%20');
                urlParts[urlParts.length - 1] = encodedFilename;
                finalDownloadLink = urlParts.join('/');
            }
            console.log(`  [LOG] Extracted final Resume Cloud link: ${finalDownloadLink}`);
            return finalDownloadLink;
        } else {
            console.log('  [LOG] Could not find the final download link on the "Resume Cloud" page.');
            return null;
        }
    } catch (error) {
        console.log(`  Error processing "Resume Cloud": ${error.message}`);
        return null;
    }
}

// Resolve driveleech link to final download URL
async function resolveDriveleechLink(driveleechUrl) {
    try {
        console.log(`\nResolving Driveleech link: ${driveleechUrl}`);
        
        const response = await axiosInstance.get(driveleechUrl, { maxRedirects: 10 });
        let $ = cheerio.load(response.data);

        // Check for JavaScript redirect
        const scriptContent = $('script').html();
        const redirectMatch = scriptContent && scriptContent.match(/window\.location\.replace\("([^"]+)"\)/);

        if (redirectMatch && redirectMatch[1]) {
            const newPath = redirectMatch[1];
            const newUrl = new URL(newPath, 'https://driveleech.net/').href;
            console.log(`  JS redirect found. Following to: ${newUrl}`);
            const newResponse = await axiosInstance.get(newUrl, { maxRedirects: 10 });
            $ = cheerio.load(newResponse.data);
        }

        // Extract file size information
        let sizeInfo = 'Unknown';
        const sizeElement = $('li.list-group-item:contains("Size :")').text();
        if (sizeElement) {
            const sizeMatch = sizeElement.match(/Size\s*:\s*([0-9.,]+\s*[KMGT]B)/);
            if (sizeMatch) {
                sizeInfo = sizeMatch[1];
            }
        }

        let movieTitle = null;
        const nameElement = $('li.list-group-item:contains("Name :")');
        if (nameElement.length > 0) {
            movieTitle = nameElement.text().replace('Name :', '').trim();
        } else {
            const h5Title = $('div.card-header h5').clone().children().remove().end().text().trim();
             if (h5Title) {
                movieTitle = h5Title.replace(/\[.*\]/, '').trim();
             }
        }

        // Try Resume Cloud first, then fallback to Instant Download
        let finalUrl = await tryResumeCloud($);
        if (finalUrl) {
             return { url: finalUrl, size: sizeInfo, title: movieTitle };
        }
        
        // Fallback to Instant Download
        console.log('  [LOG] "Resume Cloud" failed, trying "Instant Download" fallback.');
        finalUrl = await tryInstantDownload($);
        if (finalUrl) {
            return { url: finalUrl, size: sizeInfo, title: movieTitle };
        }

        console.log('  Both "Resume Cloud" and "Instant Download" methods failed.');
        return null;

    } catch (error) {
        console.error(`Error resolving driveleech link: ${error.message}`);
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
                resolve(null);
            }
        });
    });
}

// Main function
async function main() {
    const query = process.argv[2];
    if (!query) {
        console.log('Please provide a search query.');
        console.log('Usage: node topmovies_scraper.js "Your Movie Title"');
        return;
    }

    console.log(`=== TopMovies.rodeo Scraper ===`);
    console.log(`Searching for "${query}"...`);
    
    const results = await searchMovies(query);

    if (results.length === 0) {
        console.log('No results found.');
        return;
    }

    const selectedMovie = await promptUser(results, 'movie to scrape');

    if (!selectedMovie) {
        console.log('Exiting.');
        return;
    }

    const downloadInfo = await extractDownloadLinks(selectedMovie.url);

    if (downloadInfo.links.length === 0) {
        console.log('No download links found.');
        return;
    }

    console.log('\n--- Found Download Qualities ---');
    const selectedQuality = await promptUser(downloadInfo.links, 'quality to download');

    if (!selectedQuality) {
        console.log('Exiting.');
        return;
    }

    console.log(`\nSelected Quality: ${selectedQuality.quality}`);
    console.log(`Processing download link...`);

    // Step 1: Resolve leechpro.blog link to get the next intermediate link
    const intermediateUrl = await resolveLeechproLink(selectedQuality.url);
    if (!intermediateUrl) {
        console.log('❌ Failed to resolve leechpro link.');
        return;
    }

    // Step 2: If the intermediate link is a SID link, bypass it to get the driveleech link
    let driveleechUrl = intermediateUrl;
    if (intermediateUrl.includes('tech.unblockedgames.world') || intermediateUrl.includes('tech.creativeexpressionsblog.com')) {
        driveleechUrl = await resolveSidToDriveleech(intermediateUrl);
        if (!driveleechUrl) {
            console.log('❌ Failed to bypass SID link.');
            return;
        }
    }

    // Step 3: Resolve the final driveleech/driveseed link
    const finalResult = await resolveDriveleechLink(driveleechUrl);
    if (!finalResult) {
        console.log('❌ Failed to resolve the final link.');
        return;
    }

    // Success!
    console.log('\n' + '='.repeat(60));
    console.log('🎬 SUCCESS! Final Download Information:');
    console.log('='.repeat(60));
    console.log(`Movie: ${finalResult.title || downloadInfo.title}`);
    console.log(`Quality: ${selectedQuality.quality}`);
    console.log(`Size: ${finalResult.size}`);
    console.log(`Download URL: ${finalResult.url}`);
    console.log('='.repeat(60));
}

if (require.main === module) {
    main().catch(error => {
        console.error('An error occurred:', error);
    });
}

module.exports = {
    searchMovies,
    extractDownloadLinks,
    resolveLeechproLink,
    resolveSidToDriveleech,
    resolveDriveleechLink
}; 