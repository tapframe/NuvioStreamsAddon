const axios = require('axios');
const cheerio = require('cheerio');
const FormData = require('form-data');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const fs = require('fs').promises;
const path = require('path');

const TMDB_API_KEY = process.env.TMDB_API_KEY || "439c478a771f35c05022f9feabcca01c";

// --- Caching Configuration ---
const CACHE_ENABLED = process.env.DISABLE_CACHE !== 'true';
const CACHE_DIR = path.join(__dirname, '.cache', 'dramadrip');
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

// --- Caching Helper Functions ---
const ensureCacheDir = async () => {
    if (!CACHE_ENABLED) return;
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') console.error(`[DramaDrip Cache] Error creating cache directory: ${error.message}`);
    }
};

const getFromCache = async (key) => {
    if (!CACHE_ENABLED) return null;
    const cacheFile = path.join(CACHE_DIR, `${key}.json`);
    try {
        const data = await fs.readFile(cacheFile, 'utf-8');
        const cached = JSON.parse(data);
        if (Date.now() > cached.expiry) {
            console.log(`[DramaDrip Cache] EXPIRED for key: ${key}`);
            await fs.unlink(cacheFile).catch(() => {});
            return null;
        }
        console.log(`[DramaDrip Cache] HIT for key: ${key}`);
        return cached.data;
    } catch (error) {
        return null;
    }
};

const saveToCache = async (key, data) => {
    if (!CACHE_ENABLED) return;
    const cacheFile = path.join(CACHE_DIR, `${key}.json`);
    const cacheData = {
        expiry: Date.now() + CACHE_TTL,
        data: data
    };
    try {
        await fs.writeFile(cacheFile, JSON.stringify(cacheData, null, 2), 'utf-8');
        console.log(`[DramaDrip Cache] SAVED for key: ${key}`);
    } catch (error) {
        console.error(`[DramaDrip Cache] WRITE ERROR for key ${key}: ${error.message}`);
    }
};

// Initialize cache directory
ensureCacheDir();

// Helper function to parse quality strings into numerical values
function parseQuality(qualityString) {
    if (!qualityString || typeof qualityString !== 'string') return 0;
    const q = qualityString.toLowerCase();
    if (q.includes('2160p') || q.includes('4k')) return 2160;
    if (q.includes('1080p')) return 1080;
    if (q.includes('720p')) return 720;
    return 0; // Ignore qualities below 720p for sorting purposes
}

// Helper function to parse size strings into a number (in MB)
function parseSize(sizeString) {
    if (!sizeString || typeof sizeString !== 'string') return 0;
    const match = sizeString.match(/([0-9.,]+)\s*(GB|MB|KB)/i);
    if (!match) return 0;
    const sizeValue = parseFloat(match[1].replace(/,/g, ''));
    const unit = match[2].toUpperCase();
    if (unit === 'GB') return sizeValue * 1024;
    if (unit === 'MB') return sizeValue;
    if (unit === 'KB') return sizeValue / 1024;
    return 0;
}

// Search function for dramadrip.com
async function searchDramaDrip(query) {
    try {
        const searchUrl = `https://dramadrip.com/?s=${encodeURIComponent(query)}`;
        console.log(`[DramaDrip] Searching for: "${query}"`);
        const { data } = await axios.get(searchUrl);
        const $ = cheerio.load(data);
        const results = [];

        $('h2.entry-title a').each((i, element) => {
            const linkElement = $(element);
            const title = linkElement.text().trim();
            const url = linkElement.attr('href');
            if (title && url) {
                results.push({ title, url });
            }
        });
        return results;
    } catch (error) {
        console.error(`[DramaDrip] Error searching: ${error.message}`);
        return [];
    }
}

// Extracts season and quality links from a DramaDrip page
async function extractDramaDripLinks(url) {
    try {
        const { data } = await axios.get(url);
        const $ = cheerio.load(data);
        const seasons = [];
        $('h2.wp-block-heading').each((i, el) => {
            const header = $(el);
            const headerText = header.text().trim();
            if (headerText.toLowerCase().startsWith('season')) {
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
            }
        });
        return seasons;
    } catch (error) {
        console.error(`[DramaDrip] Error extracting links: ${error.message}`);
        return [];
    }
}

// Resolves intermediate links from cinematickit.org or episodes.modpro.blog
async function resolveCinemaKitOrModproLink(initialUrl, refererUrl) {
    try {
        const { data } = await axios.get(initialUrl, { headers: { 'Referer': refererUrl } });
        const $ = cheerio.load(data);
        const finalLinks = [];
        let linkSelector = '.entry-content h3:contains("Episode") a[href*="driveseed.org"]';
        let episodeLinks = $(linkSelector);

        if (episodeLinks.length === 0) {
            linkSelector = '.timed-content-client_show_0_7_0 .series_btn a[href*="driveseed.org"]';
            episodeLinks = $(linkSelector);
        }

        episodeLinks.each((i, el) => {
            const link = $(el).attr('href');
            const text = $(el).text().trim();
            if (link && text && !text.toLowerCase().includes('batch') && !text.toLowerCase().includes('zip')) {
                finalLinks.push({ episode: text.replace(/\s+/g, ' '), url: link });
            }
        });
        return finalLinks;
    } catch (error) {
        console.error(`[DramaDrip] Error resolving intermediate link: ${error.message}`);
        return [];
    }
}

// Resolves driveseed.org links to find download options
async function resolveDriveseedLink(driveseedUrl) {
    try {
        const { data } = await axios.get(driveseedUrl, { headers: { 'Referer': 'https://links.modpro.blog/' } });
        const redirectMatch = data.match(/window\.location\.replace\("([^"]+)"\)/);
        if (!redirectMatch) return null;

        const finalUrl = `https://driveseed.org${redirectMatch[1]}`;
        const { data: finalData } = await axios.get(finalUrl, { headers: { 'Referer': driveseedUrl } });
        const $ = cheerio.load(finalData);
        const downloadOptions = [];
        let title = null;
        let size = null;

        // Extract title and size from the final page
        const nameElement = $('li.list-group-item:contains("Name :")');
        if (nameElement.length > 0) {
            title = nameElement.text().replace('Name :', '').trim();
        }
        const sizeElement = $('li.list-group-item:contains("Size :")');
        if (sizeElement.length > 0) {
            size = sizeElement.text().replace('Size :', '').trim();
        }

        $('a:contains("Instant Download"), a:contains("Resume Cloud"), a:contains("Resume Worker Bot")').each((i, el) => {
            const button = $(el);
            const title = button.text().trim();
            let type = 'unknown';
            if (title.includes('Instant')) type = 'instant';
            if (title.includes('Resume Cloud')) type = 'resume';
            if (title.includes('Worker Bot')) type = 'worker';

            let url = button.attr('href');
            if (type === 'resume' && url && !url.startsWith('http')) {
                url = `https://driveseed.org${url}`;
            }
            if(url) downloadOptions.push({ title, type, url });
        });
        return { downloadOptions, title, size };
    } catch (error) {
        console.error(`[DramaDrip] Error resolving Driveseed link: ${error.message}`);
        return null;
    }
}

// Resolves the final download link from the selected method
async function resolveFinalLink(downloadOption) {
    try {
        switch (downloadOption.type) {
            case 'instant':
                const urlObject = new URL(downloadOption.url);
                const keysParam = urlObject.searchParams.get('url');
                if (!keysParam) return null;
                const { data } = await axios.post('https://video-seed.pro/api', `keys=${keysParam}`, {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-token': 'video-seed.pro' }
                });
                return data ? data.url : null;

            case 'resume':
                const { data: resumeData } = await axios.get(downloadOption.url, { headers: { 'Referer': 'https://driveseed.org/' } });
                return cheerio.load(resumeData)('a:contains("Cloud Resume Download")').attr('href');

            case 'worker':
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
                return apiResponse ? apiResponse.url : null;
            default:
                return null;
        }
    } catch (error) {
        console.error(`[DramaDrip] Error resolving final link for type ${downloadOption.type}: ${error.message}`);
        return null;
    }
}

// Main function for the provider
async function getDramaDripStreams(tmdbId, mediaType, seasonNum, episodeNum) {
    if (mediaType !== 'tv' || !seasonNum || !episodeNum) {
        console.log('[DramaDrip] Provider only supports TV shows with specified season and episode.');
        return [];
    }

    try {
        const cacheKey = `dramadrip_${tmdbId}_s${seasonNum}e${episodeNum}`;
        
        // 1. Check cache for driveseed links
        let cachedLinks = await getFromCache(cacheKey);
        if (cachedLinks) {
            console.log(`[DramaDrip Cache] Using ${cachedLinks.length} cached driveseed links.`);
        } else {
            console.log(`[DramaDrip Cache] MISS for key: ${cacheKey}. Fetching from source.`);
            // 2. If cache miss, fetch from source
            const tmdbUrl = `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}`;
            const { data: tmdbData } = await axios.get(tmdbUrl);
            const title = tmdbData.name;
            
            console.log(`[DramaDrip] Searching for: "${title}" S${seasonNum}E${episodeNum}`);
            const searchResults = await searchDramaDrip(title);
            if (searchResults.length === 0) return [];
    
            const matchingResult = searchResults.find(r => r.title.toLowerCase().includes(title.toLowerCase()));
            if (!matchingResult) return [];
    
            const seasons = await extractDramaDripLinks(matchingResult.url);
            const targetSeason = seasons.find(s => s.seasonTitle.includes(`Season ${seasonNum}`) && !s.seasonTitle.toLowerCase().includes('zip'));
            if (!targetSeason) return [];
    
            const filteredQualities = targetSeason.qualities.filter(q => !q.quality.includes('480p'));

            // 3. Resolve to driveseed links
            const resolutionPromises = filteredQualities.map(async (quality) => {
                const episodeLinks = await resolveCinemaKitOrModproLink(quality.url, matchingResult.url);
                const targetEpisode = episodeLinks.find(e => e.episode.includes(`Episode ${episodeNum}`));
                if (targetEpisode) {
                    return { ...quality, driveseedUrl: targetEpisode.url };
                }
                return null;
            });
            
            cachedLinks = (await Promise.all(resolutionPromises)).filter(Boolean);

            // 4. Save to cache
            if (cachedLinks.length > 0) {
                await saveToCache(cacheKey, cachedLinks);
            }
        }

        if (!cachedLinks || cachedLinks.length === 0) {
            console.log('[DramaDrip] No driveseed links found after scraping/cache check.');
            return [];
        }

        // 5. Always fresh-fetch the final links from driveseed URLs
        const streamPromises = cachedLinks.map(async (linkInfo) => {
            try {
                const downloadInfo = await resolveDriveseedLink(linkInfo.driveseedUrl);
                if (!downloadInfo || !downloadInfo.downloadOptions) return null;

                const { downloadOptions, title: fileTitle, size: fileSize } = downloadInfo;

                const preferredOrder = ['resume', 'worker', 'instant'];
                for (const type of preferredOrder) {
                    const method = downloadOptions.find(opt => opt.type === type);
                    if (method) {
                        const finalLink = await resolveFinalLink(method);
                        if (finalLink) {
                            return {
                                name: `DramaDrip - ${linkInfo.quality.split('(')[0].trim()}`,
                                title: `${fileTitle || "Unknown Title"}\n${fileSize || 'Unknown Size'}`,
                                url: finalLink,
                                quality: linkInfo.quality,
                                size: fileSize || '0'
                            };
                        }
                    }
                }
                return null;
            } catch (e) {
                return null;
            }
        });

        let streams = (await Promise.all(streamPromises)).filter(Boolean);
        console.log(`[DramaDrip] Found ${streams.length} streams.`);
        
        // Sort streams by size, then quality before returning
        streams.sort((a, b) => {
            const sizeA = parseSize(a.size);
            const sizeB = parseSize(b.size);
            if (sizeB !== sizeA) {
                return sizeB - sizeA;
            }
            const qualityA = parseQuality(a.quality);
            const qualityB = parseQuality(b.quality);
            return qualityB - qualityA;
        });

        return streams;

    } catch (error) {
        console.error(`[DramaDrip] Error in getDramaDripStreams: ${error.message}`);
        return [];
    }
}

module.exports = { getDramaDripStreams }; 