const axios = require('axios');
const cheerio = require('cheerio');
const { VM } = require('vm2');
const FormData = require('form-data');
const pLimit = require('p-limit').default;
const inquirer = require('inquirer');

// Configuration
const MAIN_URL = 'https://animepahe.ru';
const PROXY_URL = 'https://animepaheproxy.phisheranimepahe.workers.dev/?url=';
const HEADERS = {
    'Cookie': '__ddg2_=1234567890',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
};

// Helper function to get episode title
function getEpisodeTitle(episodeData) {
    return episodeData.title || `Episode ${episodeData.episode}`;
}

// Helper function to determine anime type
function getType(t) {
    if (t.includes('OVA') || t.includes('Special')) return 'OVA';
    else if (t.includes('Movie')) return 'AnimeMovie';
    else return 'Anime';
}

// Search function
async function search(query) {
    try {
        const url = `${PROXY_URL}${MAIN_URL}/api?m=search&l=8&q=${encodeURIComponent(query)}`;
        const headers = {
            ...HEADERS,
            'referer': `${MAIN_URL}/`
        };
        
        const response = await axios.get(url, { headers });
        const data = response.data;
        
        if (!data || !data.data) {
            console.error('No search results found');
            return [];
        }
        
        return data.data.map(item => ({
            id: item.id,
            title: item.title,
            type: item.type,
            episodes: item.episodes,
            status: item.status,
            season: item.season,
            year: item.year,
            score: item.score,
            poster: item.poster,
            session: item.session
        }));
    } catch (error) {
        console.error('Error searching:', error.message);
        return [];
    }
}

// Get latest releases
async function getLatestReleases(page = 1) {
    try {
        const url = `${PROXY_URL}${MAIN_URL}/api?m=airing&page=${page}`;
        const response = await axios.get(url, { headers: HEADERS });
        const data = response.data;
        
        if (!data || !data.data) {
            console.error('No latest releases found');
            return [];
        }
        
        return data.data.map(item => ({
            animeTitle: item.anime_title,
            episode: item.episode,
            snapshot: item.snapshot,
            createdAt: item.created_at,
            animeSession: item.anime_session
        }));
    } catch (error) {
        console.error('Error getting latest releases:', error.message);
        return [];
    }
}

// Load anime details
async function loadAnimeDetails(session) {
    try {
        const url = `${PROXY_URL}${MAIN_URL}/anime/${session}`;
        const response = await axios.get(url, { headers: HEADERS });
        const $ = cheerio.load(response.data);
        
        const japTitle = $('h2.japanese').text();
        const animeTitle = $('span.sr-only.unselectable').text();
        const poster = $('.anime-poster a').attr('href');
        const tvType = $('a[href*="/anime/type/"]').text();
        
        const year = response.data.match(/<strong>Aired:<\/strong>[^,]*, (\d+)/)?.[1];
        
        let status = 'Unknown';
        if ($('a[href="/anime/airing"]').length > 0) status = 'Ongoing';
        else if ($('a[href="/anime/completed"]').length > 0) status = 'Completed';
        
        const synopsis = $('.anime-synopsis').text();
        
        let anilistId = null;
        let malId = null;
        
        $('.external-links > a').each((i, elem) => {
            const href = $(elem).attr('href');
            if (href.includes('anilist.co')) {
                const parts = href.split('/');
                anilistId = parseInt(parts[parts.length - 1]);
            } else if (href.includes('myanimelist.net')) {
                const parts = href.split('/');
                malId = parseInt(parts[parts.length - 1]);
            }
        });
        
        const genres = [];
        $('.anime-genre > ul a').each((i, elem) => {
            genres.push($(elem).text());
        });
        
        return {
            title: animeTitle || japTitle || '',
            engName: animeTitle,
            japName: japTitle,
            poster: poster,
            type: getType(tvType),
            year: parseInt(year) || null,
            status: status,
            synopsis: synopsis,
            genres: genres,
            anilistId: anilistId,
            malId: malId,
            session: session
        };
    } catch (error) {
        console.error('Error loading anime details:', error.message);
        return null;
    }
}

// Generate list of episodes with concurrent fetching
async function generateListOfEpisodes(session) {
    try {
        const episodes = [];
        const limit = pLimit(5); // Limit to 5 concurrent requests
        
        // First, get the first page to determine total pages
        const firstPageUrl = `${PROXY_URL}${MAIN_URL}/api?m=release&id=${session}&sort=episode_asc&page=1`;
        const firstPageResponse = await axios.get(firstPageUrl, { headers: HEADERS });
        const firstPageData = firstPageResponse.data;
        
        if (!firstPageData || !firstPageData.data) {
            console.error('No episodes found');
            return [];
        }
        
        const { last_page: lastPage, per_page: perPage, total } = firstPageData;
        
        // If only one page, process all episodes in that page
        if (lastPage === 1 && perPage > total) {
            firstPageData.data.forEach(episodeData => {
                episodes.push({
                    episode: episodeData.episode,
                    title: getEpisodeTitle(episodeData),
                    snapshot: episodeData.snapshot,
                    session: episodeData.session,
                    createdAt: episodeData.created_at,
                    animeSession: session
                });
            });
        } else {
            // Fetch multiple pages concurrently
            const pagePromises = [];
            
            for (let page = 1; page <= lastPage; page++) {
                pagePromises.push(
                    limit(async () => {
                        try {
                            const pageUrl = `${PROXY_URL}${MAIN_URL}/api?m=release&id=${session}&sort=episode_asc&page=${page}`;
                            const pageResponse = await axios.get(pageUrl, { headers: HEADERS });
                            const pageData = pageResponse.data;
                            
                            if (pageData && pageData.data) {
                                return pageData.data.map(episodeData => ({
                                    episode: episodeData.episode,
                                    title: getEpisodeTitle(episodeData),
                                    snapshot: episodeData.snapshot,
                                    session: episodeData.session,
                                    createdAt: episodeData.created_at,
                                    animeSession: session
                                }));
                            }
                            return [];
                        } catch (error) {
                            console.error(`Error fetching page ${page}:`, error.message);
                            return [];
                        }
                    })
                );
            }
            
            // Wait for all pages and flatten results
            const allPageResults = await Promise.all(pagePromises);
            allPageResults.forEach(pageEpisodes => {
                episodes.push(...pageEpisodes);
            });
        }
        
        // Sort episodes by episode number
        episodes.sort((a, b) => a.episode - b.episode);
        
        return episodes;
    } catch (error) {
        console.error('Error generating episodes list:', error.message);
        return [];
    }
}

// Load video links from episode
async function loadVideoLinks(animeSession, episodeSession) {
    try {
        const episodeUrl = `${PROXY_URL}${MAIN_URL}/play/${animeSession}/${episodeSession}`;
        const response = await axios.get(episodeUrl, { headers: HEADERS });
        const $ = cheerio.load(response.data);
        
        const links = [];
        
        // Extract Pahe links from download section
        $('div#pickDownload > a').each((i, elem) => {
            const $elem = $(elem);
            const href = $elem.attr('href');
            const dubText = $elem.find('span').text();
            const type = dubText.includes('eng') ? 'DUB' : 'SUB';
            
            const text = $elem.text();
            const qualityMatch = text.match(/(.+?)\s+·\s+(\d{3,4}p)/);
            const source = qualityMatch?.[1] || 'Unknown';
            const quality = qualityMatch?.[2]?.replace('p', '') || 'Unknown';
            
            if (href) {
                links.push({
                    source: `Animepahe [Pahe] ${source} [${type}]`,
                    url: href,
                    quality: quality,
                    type: type,
                    extractor: 'pahe'
                });
            }
        });
        
        return links;
    } catch (error) {
        console.error('Error loading video links:', error.message);
        return [];
    }
}

// Pahe extractor - complex extraction with decryption
async function extractPahe(url) {
    try {
        // Step 1: Get redirect location from /i endpoint
        const redirectResponse = await axios.get(`${url}/i`, {
            maxRedirects: 0,
            validateStatus: (status) => status >= 200 && status < 400,
            headers: HEADERS
        });
        
        const location = redirectResponse.headers.location;
        if (!location) {
            console.error('No redirect location found');
            return null;
        }
        
        const kwikUrl = 'https://' + location.split('https://').pop();
        
        // Step 2: Get the Kwik page content
        const kwikResponse = await axios.get(kwikUrl, {
            headers: {
                ...HEADERS,
                'Referer': 'https://kwik.cx/'
            }
        });
        
        const kwikContent = kwikResponse.data;
        
        // Step 3: Extract parameters for decryption
        const paramsMatch = kwikContent.match(/\("(\w+)",\d+,"(\w+)",(\d+),(\d+),\d+\)/);
        if (!paramsMatch) {
            console.error('Could not find decryption parameters');
            return null;
        }
        
        const [, fullString, key, v1, v2] = paramsMatch;
        
        // Step 4: Decrypt using the custom algorithm
        const decrypted = decryptPahe(fullString, key, parseInt(v1), parseInt(v2));
        
        // Step 5: Extract URL and token from decrypted content
        const urlMatch = decrypted.match(/action="([^"]+)"/);
        const tokenMatch = decrypted.match(/value="([^"]+)"/);
        
        if (!urlMatch || !tokenMatch) {
            console.error('Could not extract URL or token from decrypted content');
            return null;
        }
        
        const postUrl = urlMatch[1];
        const token = tokenMatch[1];
        
        // Step 6: Make POST request with form data to get final URL
        const formData = new FormData();
        formData.append('_token', token);
        
        let finalResponse;
        let attempts = 0;
        const maxAttempts = 20;
        
        // Keep trying until we get a redirect
        while (attempts < maxAttempts) {
            try {
                finalResponse = await axios.post(postUrl, formData, {
                    headers: {
                        ...HEADERS,
                        'Referer': kwikResponse.request.res.responseUrl,
                        'Cookie': kwikResponse.headers['set-cookie']?.[0] || ''
                    },
                    maxRedirects: 0,
                    validateStatus: (status) => status >= 200 && status < 400
                });
                
                if (finalResponse.status === 302) {
                    break;
                }
            } catch (error) {
                // Continue trying
            }
            
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 100)); // Small delay between attempts
        }
        
        if (!finalResponse || finalResponse.status !== 302) {
            console.error('Failed to get redirect after multiple attempts');
            return null;
        }
        
        const finalUrl = finalResponse.headers.location;
        
        return {
            url: finalUrl,
            headers: {
                'Referer': ''
            },
            type: 'direct'
        };
        
    } catch (error) {
        console.error('Error extracting from Pahe:', error.message);
        return null;
    }
}

// Pahe decryption algorithm
function decryptPahe(fullString, key, v1, v2) {
    const keyIndexMap = {};
    for (let i = 0; i < key.length; i++) {
        keyIndexMap[key[i]] = i;
    }
    
    let result = '';
    let i = 0;
    const toFind = key[v2];
    
    while (i < fullString.length) {
        const nextIndex = fullString.indexOf(toFind, i);
        if (nextIndex === -1) break;
        
        let decodedCharStr = '';
        for (let j = i; j < nextIndex; j++) {
            const index = keyIndexMap[fullString[j]];
            if (index !== undefined) {
                decodedCharStr += index;
            } else {
                decodedCharStr += '-1';
            }
        }
        
        i = nextIndex + 1;
        
        const decodedValue = parseInt(decodedCharStr, v2) - v1;
        const decodedChar = String.fromCharCode(decodedValue);
        result += decodedChar;
    }
    
    return result;
}

// Main function to extract final video URLs
async function extractFinalUrl(link) {
    if (link.extractor === 'pahe') {
        return await extractPahe(link.url);
    }
    return null;
}

// Helper function to verify if a URL is accessible
async function verifyUrl(url, headers = {}) {
    try {
        console.log(`Verifying URL: ${url}`);
        const response = await axios.head(url, { 
            headers,
            timeout: 5000,
            validateStatus: status => status < 400
        });
        console.log(`URL verification successful! Status: ${response.status}`);
        return true;
    } catch (error) {
        console.error(`URL verification failed: ${error.message}`);
        return false;
    }
}

// Interactive main function
async function main() {
    console.log('Welcome to the Interactive AnimePahe Scraper!\n');

    try {
        // 1. Get search query from user
        const { searchQuery } = await inquirer.prompt([
            {
                type: 'input',
                name: 'searchQuery',
                message: 'What anime would you like to search for?',
                validate: input => input ? true : 'Please enter an anime name.'
            }
        ]);

        console.log(`\nSearching for "${searchQuery}"...`);
        const searchResults = await search(searchQuery);

        if (searchResults.length === 0) {
            console.log('No results found. Please try another search.');
            return;
        }

        // 2. Let user choose an anime from the results
        const { selectedAnime } = await inquirer.prompt([
            {
                type: 'list',
                name: 'selectedAnime',
                message: 'Please select an anime:',
                choices: searchResults.map(anime => ({
                    name: `${anime.title} (${anime.year || 'N/A'}, ${anime.episodes} episodes, ${anime.status})`,
                    value: anime
                }))
            }
        ]);

        console.log(`\nFetching details for "${selectedAnime.title}"...`);
        const animeDetails = await loadAnimeDetails(selectedAnime.session);
        if (animeDetails) {
            console.log(`> Type: ${animeDetails.type}`);
            console.log(`> Status: ${animeDetails.status}`);
            console.log(`> Genres: ${animeDetails.genres.join(', ')}`);
            console.log(`> Synopsis: ${animeDetails.synopsis.substring(0, 100)}...`);
        }

        // 3. Fetch and let user choose an episode
        console.log('\nFetching episode list...');
        const episodes = await generateListOfEpisodes(selectedAnime.session);

        if (episodes.length === 0) {
            console.log('No episodes found for this anime.');
            return;
        }
        
        const { selectedEpisode } = await inquirer.prompt([
            {
                type: 'list',
                name: 'selectedEpisode',
                message: 'Please select an episode:',
                choices: episodes.map(ep => ({
                    name: `Episode ${ep.episode}: ${ep.title}`,
                    value: ep
                })),
                pageSize: 15
            }
        ]);

        // 4. Fetch and let user choose a video link/quality
        console.log(`\nGetting video links for Episode ${selectedEpisode.episode}...`);
        const videoLinks = await loadVideoLinks(selectedAnime.session, selectedEpisode.session);

        if (videoLinks.length === 0) {
            console.log('No video links found for this episode.');
            return;
        }

        // Filter to only show Pahe links
        const paheLinks = videoLinks.filter(link => link.extractor === 'pahe');
        
        if (paheLinks.length === 0) {
            console.log('No Pahe links found for this episode. Please try another episode.');
            return;
        }

        const { selectedLink } = await inquirer.prompt([
            {
                type: 'list',
                name: 'selectedLink',
                message: 'Please select a video source and quality:',
                choices: paheLinks.map(link => ({
                    name: `${link.source} - ${link.quality}p`,
                    value: link
                }))
            }
        ]);
        
        // 5. Extract and display the final URL
        console.log('\nExtracting final streaming URL...');
        console.log(`Using ${selectedLink.extractor} extractor for ${selectedLink.source}...`);
        
        const finalUrl = await extractFinalUrl(selectedLink);

        if (finalUrl) {
            console.log('\n✅ Success! Final streaming URL extracted:');
            console.log(`URL: ${finalUrl.url}`);
            console.log(`Type: ${finalUrl.type}`);
            console.log('Headers:', JSON.stringify(finalUrl.headers, null, 2));
            
            // Verify if the URL is accessible
            console.log('\nVerifying if the URL is accessible...');
            const isValid = await verifyUrl(finalUrl.url, finalUrl.headers);
            
            if (isValid) {
                console.log('\n🎉 URL verification successful! The streaming URL is working.');
            } else {
                console.log('\n⚠️ URL verification failed. The streaming URL may not be accessible.');
            }
        } else {
            console.log('\n❌ Failed to extract streaming URL from the selected source.');
        }

    } catch (error) {
        if (error.isTtyError) {
            console.error('Error: This program needs to be run in an interactive terminal.');
        } else {
            console.error('An unexpected error occurred in main:', error);
        }
    }
}

// Export all functions for use as a module
module.exports = {
    search,
    getLatestReleases,
    loadAnimeDetails,
    generateListOfEpisodes,
    loadVideoLinks,
    extractPahe,
    extractFinalUrl
};

// Run main function if this file is executed directly
if (require.main === module) {
    main();
} 