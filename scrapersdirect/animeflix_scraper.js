const axios = require('axios');
const cheerio = require('cheerio');
const readline = require('readline');
const FormData = require('form-data');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');

const BASE_URL = 'https://animeflix.pm';

// Search for anime on AnimeFlix
async function searchAnime(query) {
    try {
        const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
        const { data } = await axios.get(searchUrl);
        const $ = cheerio.load(data);

        const results = [];
        $('a[href*="https://animeflix.pm/"]').each((i, element) => {
            const linkElement = $(element);
            const title = linkElement.attr('title');
            const url = linkElement.attr('href');

            if (title && url && !results.some(r => r.url === url)) { // Ensure unique URLs
                results.push({ title, url });
            }
        });

        console.log(`Found ${results.length} results for "${query}" on AnimeFlix`);
        return results;
    } catch (error) {
        console.error(`Error searching on AnimeFlix: ${error.message}`);
        return [];
    }
}

// Extract the main download page link (e.g., Gdrive + Mirrors)
async function extractMainDownloadLink(animePageUrl) {
    try {
        console.log(`\nExtracting initial links from: ${animePageUrl}`);
        const { data } = await axios.get(animePageUrl);
        const $ = cheerio.load(data);
        const links = [];

        // Find all h3 tags that seem to indicate a quality/download section
        $('h3:contains("720p"), h3:contains("1080p")').each((i, el) => {
            const header = $(el);
            const qualityText = header.text().trim();
            
            // Find the "Gdrive + Mirrors" link in the next element
            const gdriveLink = header.next('p').find('a:contains("Gdrive + Mirrors")');

            if (gdriveLink.length > 0) {
                const linkUrl = gdriveLink.attr('href');
                console.log(`Found link for "${qualityText}": ${linkUrl}`);
                links.push({
                    source: qualityText, // Use the header text as the source/quality indicator
                    url: linkUrl
                });
            }
        });

        if (links.length === 0) {
            console.log('Could not find any "Gdrive + Mirrors" links associated with quality headers.');
        }

        return links;
    } catch (error) {
        console.error(`Error extracting main download link: ${error.message}`);
        return [];
    }
}

// Scrape the episodes.animeflix.pm page for all episode /getlink/ URLs
async function resolveGdriveMirrorPage(episodePageUrl) {
    try {
        console.log(`\nScraping episode list from: ${episodePageUrl}`);
        const { data } = await axios.get(episodePageUrl);
        const $ = cheerio.load(data);
        const episodeLinks = [];

        $('a[href*="/getlink/"]').each((i, el) => {
            const link = $(el).attr('href');
            const episodeText = $(el).text().trim().replace(/[⌈⌋_]/g, ''); // Clean up text like "⌈Episode 1⌋"

            if (link && episodeText) {
                episodeLinks.push({
                    title: episodeText,
                    url: link
                });
            }
        });

        console.log(`Found ${episodeLinks.length} episode links.`);
        return episodeLinks;
    } catch (error) {
        console.error(`Error resolving Gdrive/Mirror page: ${error.message}`);
        return [];
    }
}

// Placeholder for resolving the final /getlink/ URL
async function resolveGetLink(getLinkUrl) {
    try {
        console.log(`\nResolving final link from: ${getLinkUrl}`);
        // Use axios to follow the redirect. The final URL will be in the response object.
        const response = await axios.get(getLinkUrl, {
            maxRedirects: 5 // Follow up to 5 redirects
        });
        
        // The final URL after all redirects is in `response.request.res.responseUrl`
        const finalUrl = response.request.res.responseUrl;
        
        if (finalUrl) {
            console.log(`  Redirect resolved to: ${finalUrl}`);
            return finalUrl;
        } else {
            console.log('  Could not resolve the final URL after redirects.');
            return null;
        }
    } catch (error) {
        console.error(`Error resolving getlink: ${error.message}`);
        if (error.response) {
            console.error(`  Status: ${error.response.status}`);
        }
        return null;
    }
}

// Follows the anishort.xyz redirector to get the final link
async function resolveAnishortLink(anishortUrl) {
    try {
        console.log(`\nResolving anishort.xyz link: ${anishortUrl}`);
        const { data } = await axios.get(anishortUrl);
        const $ = cheerio.load(data);
        
        // Find the "Download Now" button and extract its link
        const downloadLink = $('a.button-24').attr('href');

        if (downloadLink) {
            console.log(`  Anishort resolved to: ${downloadLink}`);
            return downloadLink;
        } else {
            console.log('  Could not find the download button on the anishort.xyz page.');
            return null;
        }
    } catch (error) {
        console.error(`Error resolving anishort.xyz link: ${error.message}`);
        return null;
    }
}

// Follows the driveleech.net redirector to get the final video URL
async function resolveDriveleechLink(driveleechUrl) {
    try {
        console.log(`\nResolving driveleech.net link: ${driveleechUrl}`);
        const { data } = await axios.get(driveleechUrl);

        // Check for the JavaScript redirect first
        const redirectMatch = data.match(/window\.location\.replace\("([^"]+)"\)/);
        if (redirectMatch && redirectMatch[1]) {
            const nextPath = redirectMatch[1];
            const nextUrl = new URL(nextPath, driveleechUrl).href;
            console.log(`  Found JavaScript redirect. Following to: ${nextUrl}`);
            // Recursively call to handle the next page in the chain
            return await resolveDriveleechLink(nextUrl);
        }

        // If no JS redirect, look for the final download button on the current page
        const $ = cheerio.load(data);
        const finalLink = $('a.btn-danger:contains("Instant Download")').attr('href');
        
        if (finalLink) {
            console.log(`  Found "Instant Download" link: ${finalLink}`);
            return finalLink;
        }

        console.log('  Could not find a JS redirect or an "Instant Download" button.');
        console.log('--- BEGIN Driveleech HTML ---');
        console.log(data);
        console.log('--- END Driveleech HTML ---');
        return null;

    } catch (error) {
        console.error(`Error resolving driveleech.net link: ${error.message}`);
        return null;
    }
}

// Resolves the video-leech.pro API to get the final video URL (adapted from UHDMovies logic)
async function resolveVideoLeechLink(videoLeechUrl) {
    try {
        console.log(`\nResolving Video-leech link: ${videoLeechUrl}`);
        const urlObject = new URL(videoLeechUrl);
        const keysParam = urlObject.searchParams.get('url');

        if (!keysParam) {
            console.error('Could not find the "url" parameter in the video-leech.pro link.');
            return null;
        }

        const apiUrl = `${urlObject.origin}/api`;
        console.log(`  POSTing to API endpoint: ${apiUrl}`);

        const { data } = await axios.post(apiUrl, `keys=${keysParam}`, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'x-token': urlObject.hostname // Use the hostname from the URL as the token
            }
        });

        if (data && data.url) {
            console.log(`  SUCCESS! Final video link from API: ${data.url}`);
            return data.url;
        } else if (data && data.message) {
            console.error(`  API Error: ${data.message}`);
            return null;
        } else {
            console.log('  API request did not return a valid link object.');
            console.log('  Received:', data);
            return null;
        }
    } catch (error) {
        console.error(`Error resolving Video-leech link: ${error.message}`);
        return null;
    }
}

// Function to prompt user for selection
function promptUser(results, promptTitle) {
    return new Promise((resolve) => {
        if (!results || results.length === 0) {
            console.log(`No items to select for: ${promptTitle}`);
            return resolve(null);
        }
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        console.log(`\nPlease select a ${promptTitle}:`);
        results.forEach((result, index) => {
            const displayText = result.title || result.source;
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
    const queryArgs = process.argv.slice(2);
    if (queryArgs.length === 0) {
        console.log('Please provide a search query.');
        console.log('Usage: node scrapersdirect/animeflix_scraper.js "Your Anime Title"');
        return;
    }
    const query = queryArgs.join(' ');

    console.log(`Searching for "${query}"...`);
    const searchResults = await searchAnime(query);

    if (searchResults.length === 0) {
        return;
    }

    const selectedAnime = await promptUser(searchResults, 'anime to scrape');
    if (!selectedAnime) {
        console.log('Exiting.');
        return;
    }

    const mainDownloadLinks = await extractMainDownloadLink(selectedAnime.url);
    if (mainDownloadLinks.length === 0) {
        return;
    }

    const selectedSource = await promptUser(mainDownloadLinks, 'download source');
    if (!selectedSource) {
        console.log('Exiting.');
        return;
    }

    console.log(`Selected Source: ${selectedSource.source}`);

    // Get all the episode /getlink/ urls
    const episodeLinks = await resolveGdriveMirrorPage(selectedSource.url);

    if (episodeLinks.length === 0) {
        console.log('\nCould not find any episode links.');
        return;
    }

    const selectedEpisode = await promptUser(episodeLinks, 'episode');
    if (!selectedEpisode) {
        console.log('Exiting.');
        return;
    }

    // Resolve the final link for the selected episode
    const anishortLink = await resolveGetLink(selectedEpisode.url);

    if (anishortLink) {
        const driveleechLink = await resolveAnishortLink(anishortLink);

        if (driveleechLink) {
            const videoLeechLink = await resolveDriveleechLink(driveleechLink);
            
            if (videoLeechLink) {
                const finalLink = await resolveVideoLeechLink(videoLeechLink);
                if (finalLink) {
                    console.log('\n================================');
                    console.log('✅ Final Download Link Found:');
                    console.log(finalLink);
                    console.log('================================');
                } else {
                    console.log('Failed to resolve the final video-leech.pro link.');
                }
            } else {
                console.log('Failed to resolve the final driveleech.net link.');
            }
        } else {
            console.log('Failed to resolve the anishort.xyz link.');
        }
    } else {
        console.log('Failed to resolve the getlink URL.');
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    searchAnime,
    extractMainDownloadLink,
}; 