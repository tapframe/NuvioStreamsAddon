const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const cheerio = require('cheerio');
const { CookieJar } = require('tough-cookie');
const { URLSearchParams, URL } = require('url');
const FormData = require('form-data');
const { findBestMatch } = require('string-similarity');
const RedisCache = require('../utils/redisCache');
const { followRedirectToFilePage, extractFinalDownloadFromFilePage } = require('../utils/linkResolver');

// Dynamic import for axios-cookiejar-support
let axiosCookieJarSupport = null;
const getAxiosCookieJarSupport = async () => {
  if (!axiosCookieJarSupport) {
    axiosCookieJarSupport = await import('axios-cookiejar-support');
  }
  return axiosCookieJarSupport;
};

// --- Domain Fetching ---
let topMoviesDomain = 'https://topmovies.rodeo'; // Fallback domain
let domainCacheTimestamp = 0;
const DOMAIN_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

async function getTopMoviesDomain() {
    const now = Date.now();
    if (now - domainCacheTimestamp < DOMAIN_CACHE_TTL) {
        return topMoviesDomain;
    }

    try {
        console.log('[TopMovies] Fetching latest domain...');
        const response = await makeRequest('https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json', { timeout: 10000 });
        if (response.data && response.data.topMovies) {
            topMoviesDomain = response.data.topMovies;
            domainCacheTimestamp = now;
            console.log(`[TopMovies] Updated domain to: ${topMoviesDomain}`);
        } else {
            console.warn('[TopMovies] Domain JSON fetched, but "topMovies" key was not found. Using fallback.');
        }
    } catch (error) {
        console.error(`[TopMovies] Failed to fetch latest domain, using fallback. Error: ${error.message}`);
    }
    return topMoviesDomain;
}

const TMDB_API_KEY = process.env.TMDB_API_KEY || "439c478a771f35c05022f9feabcca01c"; // Fallback to a public key

// --- Proxy Configuration ---
const TOPMOVIES_PROXY_URL = process.env.TOPMOVIES_PROXY_URL;
if (TOPMOVIES_PROXY_URL) {
    console.log(`[TopMovies] Using proxy: ${TOPMOVIES_PROXY_URL}`);
} else {
    console.log('[TopMovies] No proxy configured');
}

// Proxy wrapper function
const makeRequest = (url, options = {}) => {
    if (TOPMOVIES_PROXY_URL) {
        const proxiedUrl = `${TOPMOVIES_PROXY_URL}${encodeURIComponent(url)}`;
        console.log(`[TopMovies] Making proxied request to: ${url}`);
        return axios.get(proxiedUrl, options);
    } else {
        console.log(`[TopMovies] Making direct request to: ${url}`);
        return axios.get(url, options);
    }
};

// --- Scraper Functions ---

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
        const baseUrl = await getTopMoviesDomain();
        const searchUrl = `${baseUrl}/search/${encodeURIComponent(query)}`;
        console.log(`Searching: ${searchUrl}`);
        
        const { data } = await makeRequest(searchUrl);
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
        const { data } = await makeRequest(moviePageUrl);
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
        const { data } = await makeRequest(leechproUrl);
        const $ = cheerio.load(data);

        // Look for any of our supported link types in the timed content section first
        let resolvedLink = null;
        
        const timedContent = $('.timed-content-client_show_0_5_0');
        if (timedContent.length > 0) {
            const supportedLink = timedContent.find('a[href*="tech.unblockedgames.world"], a[href*="tech.creativeexpressionsblog.com"], a[href*="tech.examzculture.in"], a[href*="driveseed.org"], a[href*="driveleech.net"]').first();
            if (supportedLink.length > 0) {
                resolvedLink = supportedLink.attr('href');
            }
        }

        // Fallback: look anywhere on the page for the links
        if (!resolvedLink) {
            const allSupportedLinks = $('a[href*="tech.unblockedgames.world"], a[href*="tech.creativeexpressionsblog.com"], a[href*="tech.examzculture.in"], a[href*="driveseed.org"], a[href*="driveleech.net"]');
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

// Helper function to extract cookies from jar for a specific URL
const getCookiesForUrl = async (jar, url) => {
    try {
        const cookies = await jar.getCookies(url);
        return cookies.map(cookie => cookie.toString()).join('; ');
    } catch (error) {
        console.error(`[TopMovies] Error extracting cookies: ${error.message}`);
        return '';
    }
};

// Copy of the tech.unblockedgames.world bypass from uhdmovies scraper
async function resolveSidToDriveleech(sidUrl) {
    console.log(`[TopMovies] Resolving SID link: ${sidUrl}`);
    const { origin } = new URL(sidUrl);
    const jar = new CookieJar();
    
    // Get the wrapper function from dynamic import
    const { wrapper } = await getAxiosCookieJarSupport();
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
    
    // If proxy is enabled, wrap the session methods to use proxy
    if (TOPMOVIES_PROXY_URL) {
        console.log(`[TopMovies] Creating SID session with proxy: ${TOPMOVIES_PROXY_URL}`);
        const originalGet = session.get.bind(session);
        const originalPost = session.post.bind(session);

        session.get = async (url, options = {}) => {
            const proxiedUrl = `${TOPMOVIES_PROXY_URL}${encodeURIComponent(url)}`;
            console.log(`[TopMovies] Making proxied SID GET request to: ${url}`);
            
            // Extract cookies from jar and add to headers
            const cookieString = await getCookiesForUrl(jar, url);
            if (cookieString) {
                console.log(`[TopMovies] Adding cookies to proxied request: ${cookieString}`);
                options.headers = {
                    ...options.headers,
                    'Cookie': cookieString
                };
            }
            
            return originalGet(proxiedUrl, options);
        };

        session.post = async (url, data, options = {}) => {
            const proxiedUrl = `${TOPMOVIES_PROXY_URL}${encodeURIComponent(url)}`;
            console.log(`[TopMovies] Making proxied SID POST request to: ${url}`);
            
            // Extract cookies from jar and add to headers
            const cookieString = await getCookiesForUrl(jar, url);
            if (cookieString) {
                console.log(`[TopMovies] Adding cookies to proxied request: ${cookieString}`);
                options.headers = {
                    ...options.headers,
                    'Cookie': cookieString
                };
            }
            
            return originalPost(proxiedUrl, data, options);
        };
    }

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

            let apiResponse;
            if (TOPMOVIES_PROXY_URL) {
                const proxiedApiUrl = `${TOPMOVIES_PROXY_URL}${encodeURIComponent(apiUrl)}`;
                console.log(`[TopMovies] Making proxied POST request for Instant Download API to: ${apiUrl}`);
                apiResponse = await axiosInstance.post(proxiedApiUrl, formData, {
                    headers: {
                        ...formData.getHeaders(),
                        'x-token': new URL(instantDownloadLink).hostname
                    }
                });
            } else {
                apiResponse = await axiosInstance.post(apiUrl, formData, {
                    headers: {
                        ...formData.getHeaders(),
                        'x-token': new URL(instantDownloadLink).hostname
                    }
                });
            }

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
        
        const finalPageResponse = await makeRequest(resumeUrl, { maxRedirects: 10 });
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

// Environment variable to control URL validation
const URL_VALIDATION_ENABLED = process.env.DISABLE_URL_VALIDATION !== 'true';
console.log(`[TopMovies] URL validation is ${URL_VALIDATION_ENABLED ? 'enabled' : 'disabled'}.`);

// Validate if a video URL is working (not 404 or broken)
async function validateVideoUrl(url, timeout = 10000) {
    // Skip validation if disabled via environment variable
    if (!URL_VALIDATION_ENABLED) {
        console.log(`[TopMovies] URL validation disabled, skipping validation for: ${url.substring(0, 100)}...`);
        return true;
    }

    try {
        console.log(`[TopMovies] Validating URL: ${url.substring(0, 100)}...`);
        
        // Use proxy for URL validation if enabled
        let response;
        if (TOPMOVIES_PROXY_URL) {
            const proxiedUrl = `${TOPMOVIES_PROXY_URL}${encodeURIComponent(url)}`;
            console.log(`[TopMovies] Making proxied HEAD request for validation to: ${url}`);
            response = await axios.head(proxiedUrl, {
                timeout,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Range': 'bytes=0-1' // Just request first byte to test
                }
            });
        } else {
            response = await axios.head(url, {
                timeout,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Range': 'bytes=0-1' // Just request first byte to test
                }
            });
        }
        
        // Check if status is OK (200-299) or partial content (206)
        if (response.status >= 200 && response.status < 400) {
            console.log(`[TopMovies] ✓ URL validation successful (${response.status})`);
            return true;
        } else {
            console.log(`[TopMovies] ✗ URL validation failed with status: ${response.status}`);
            return false;
        }
    } catch (error) {
        console.log(`[TopMovies] ✗ URL validation failed: ${error.message}`);
        return false;
    }
}

// Resolve driveleech link to final download URL
async function resolveDriveleechLink(driveleechUrl) {
    try {
        console.log(`\nResolving Driveleech link: ${driveleechUrl}`);
        
        const response = await makeRequest(driveleechUrl, { maxRedirects: 10 });
        let $ = cheerio.load(response.data);

        // Check for JavaScript redirect
        const scriptContent = $('script').html();
        const redirectMatch = scriptContent && scriptContent.match(/window\.location\.replace\("([^"]+)"\)/);

        if (redirectMatch && redirectMatch[1]) {
            const newPath = redirectMatch[1];
            const newUrl = new URL(newPath, 'https://driveleech.net/').href;
            console.log(`  JS redirect found. Following to: ${newUrl}`);
            const newResponse = await makeRequest(newUrl, { maxRedirects: 10 });
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

        // Try each download method in order until we find a working one
        const downloadMethods = [
            { name: 'Resume Cloud', func: tryResumeCloud },
            { name: 'Instant Download', func: tryInstantDownload }
        ];

        for (const method of downloadMethods) {
            try {
                console.log(`[TopMovies] Trying ${method.name}...`);
                const finalUrl = await method.func($);
                
                if (finalUrl) {
                    // Validate the URL before using it
                    const isValid = await validateVideoUrl(finalUrl);
                    if (isValid) {
                        console.log(`[TopMovies] ✓ Successfully resolved using ${method.name}`);
                        return { url: finalUrl, size: sizeInfo, title: movieTitle };
                    } else {
                        console.log(`[TopMovies] ✗ ${method.name} returned invalid/broken URL, trying next method...`);
                    }
                } else {
                    console.log(`[TopMovies] ✗ ${method.name} failed to resolve URL, trying next method...`);
                }
            } catch (error) {
                console.log(`[TopMovies] ✗ ${method.name} threw error: ${error.message}, trying next method...`);
            }
        }

        console.log('[TopMovies] ✗ All download methods failed.');
        return null;

    } catch (error) {
        console.error(`Error resolving driveleech link: ${error.message}`);
        return null;
    }
}

// --- Caching Configuration ---
const CACHE_ENABLED = process.env.DISABLE_CACHE !== 'true';
const CACHE_DIR = process.env.VERCEL ? path.join('/tmp', '.topmovies_cache') : path.join(__dirname, '.cache', 'topmovies');
// --- Caching Helper Functions ---
const ensureCacheDir = async () => {
    if (!CACHE_ENABLED) return;
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') console.error(`[TopMovies Cache] Error creating cache directory: ${error.message}`);
    }
};

// Initialize Redis cache
const redisCache = new RedisCache('TopMovies');

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

// Initialize cache directory
ensureCacheDir();

// Helper to compare titles and years
function compareMedia(mediaInfo, searchResult) {
  const normalize = (str) => String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const mediaTitle = normalize(mediaInfo.title);
  const resultTitle = normalize(searchResult.title);

  if (!resultTitle.includes(mediaTitle)) {
    return false;
  }

  if (mediaInfo.year && searchResult.title.includes('(')) {
    const yearMatch = searchResult.title.match(/\((\d{4})\)/);
    if (yearMatch && Math.abs(parseInt(yearMatch[1], 10) - mediaInfo.year) > 1) {
      return false; // Allow a 1-year difference for release dates
    }
  }

  return true;
}

async function getTopMoviesStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  if (mediaType === 'tv') {
    console.log('[TopMovies] TV shows are not supported by this provider.');
    return [];
  }

  console.log(`[TopMovies] Attempting to fetch streams for TMDB ID: ${tmdbId}`);

  try {
    const cacheKey = `topmovies_final_v16_${tmdbId}`;
    
    // 1. Check cache for intermediate links
    let cachedLinks = await getFromCache(cacheKey);
    if (cachedLinks && cachedLinks.length > 0) {
        console.log(`[TopMovies Cache] Using ${cachedLinks.length} cached driveleech links.`);
    } else {
        if (cachedLinks && cachedLinks.length === 0) {
            console.log(`[TopMovies] Cache contains empty data for ${cacheKey}. Refetching from source.`);
        } else {
            console.log(`[TopMovies Cache] MISS for key: ${cacheKey}. Fetching from source.`);
        }
        console.log(`[TopMovies Cache] MISS for key: ${cacheKey}. Fetching from source.`);
        // 2. Get TMDB info
        const tmdbUrl = `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_API_KEY}`;
        const tmdbResponse = await axios.get(tmdbUrl);
        const mediaInfo = {
          title: tmdbResponse.data.title,
          year: parseInt((tmdbResponse.data.release_date || '').split('-')[0], 10)
        };
        
        console.log(`[TopMovies] TMDB Info: "${mediaInfo.title}" (${mediaInfo.year})`);

        // 3. Search and extract links
        const searchResults = await searchMovies(mediaInfo.title);
        if (searchResults.length === 0) {
          console.log(`[TopMovies] No search results for "${mediaInfo.title}".`);
          return [];
        }

        const matchingResult = searchResults.find(result => compareMedia(mediaInfo, result));
        if (!matchingResult) {
          console.log(`[TopMovies] No matching content found for "${mediaInfo.title}" (${mediaInfo.year}).`);
          return [];
        }

        console.log(`[TopMovies] Found matching content: "${matchingResult.title}"`);
        const downloadInfo = await extractDownloadLinks(matchingResult.url);
        if (!downloadInfo || downloadInfo.links.length === 0) {
          console.log('[TopMovies] No download links found on page.');
          return [];
        }

        // Filter out 480p links before resolving
        const filteredLinks = downloadInfo.links.filter(link => !link.quality.includes('480p'));

        // 4. Resolve to final driveleech file page URLs (window.replace URLs)
        const resolutionPromises = filteredLinks.map(async (qualityLink) => {
            try {
                const intermediateUrl = await resolveLeechproLink(qualityLink.url);
                if (!intermediateUrl) return null;

                let driveleechUrl = intermediateUrl;
                // If it's a SID link, resolve it first
                if (intermediateUrl.includes('tech.unblockedgames.world') || intermediateUrl.includes('tech.creativeexpressionsblog.com') || intermediateUrl.includes('tech.examzculture.in')) {
                    driveleechUrl = await resolveSidToDriveleech(intermediateUrl);
                }
                
                if (!driveleechUrl) return null;

                console.log(`[TopMovies] Caching driveleech redirect URL: ${driveleechUrl}`);
                return { ...qualityLink, driveleechRedirectUrl: driveleechUrl };
            } catch (error) {
                console.error(`[TopMovies] Error resolving ${qualityLink.quality}: ${error.message}`);
                return null;
            }
        });
        
        cachedLinks = (await Promise.all(resolutionPromises)).filter(Boolean);

        // 5. Save to cache
        if (cachedLinks.length > 0) {
            await saveToCache(cacheKey, cachedLinks);
        }
    }

    if (!cachedLinks || cachedLinks.length === 0) {
        console.log('[TopMovies] No driveleech links found after scraping/cache check.');
        return [];
    }

    // 6. Process cached driveleech redirect URLs to get streaming links
    const streamPromises = cachedLinks.map(async (cachedLink) => {
      try {
        console.log(`[TopMovies] Processing cached driveleech redirect: ${cachedLink.quality}`);
        // Resolve redirect to final file page using shared util
        const resFollow = await followRedirectToFilePage({
          redirectUrl: cachedLink.driveleechRedirectUrl,
          get: (url, opts) => makeRequest(url, opts),
          log: console
        });
        const $ = resFollow.$;
        const finalFilePageUrl = resFollow.finalFilePageUrl;
        console.log(`[TopMovies] Resolved redirect to final file page: ${finalFilePageUrl}`);

        // Use shared util to extract the final URL from file page
        const origin = new URL(finalFilePageUrl).origin;
        const finalDownloadUrl = await extractFinalDownloadFromFilePage($, {
          origin,
          get: (url, opts) => makeRequest(url, opts),
          post: (url, data, opts) => axios.post(TOPMOVIES_PROXY_URL ? `${TOPMOVIES_PROXY_URL}${encodeURIComponent(url)}` : url, data, opts),
          validate: (url) => validateVideoUrl(url),
          log: console
        });

        if (!finalDownloadUrl) {
          console.log('[TopMovies] ✗ Could not extract final link for', cachedLink.quality);
          return null;
        }

        const cleanQualityMatch = (cachedLink.quality || '').match(/(\d{3,4}p|4K)/i);
        const cleanQuality = cleanQualityMatch ? cleanQualityMatch[0] : (cachedLink.quality || 'UNK');

        // Extract size and title for display (best-effort)
        let sizeInfo = 'Unknown';
        let movieTitle = null;
        const sizeElement = $('li.list-group-item:contains("Size :")').text();
        if (sizeElement) {
          const sizeMatch = sizeElement.match(/Size\s*:\s*([0-9.,]+\s*[KMGT]B)/);
          if (sizeMatch) {
            sizeInfo = sizeMatch[1];
          }
        }
        const nameElement = $('li.list-group-item:contains("Name :")');
        if (nameElement.length > 0) {
          movieTitle = nameElement.text().replace('Name :', '').trim();
        } else {
          const h5Title = $('div.card-header h5').clone().children().remove().end().text().trim();
          if (h5Title) {
            movieTitle = h5Title.replace(/\[.*\]/, '').trim();
          }
        }

        return {
          name: `TopMovies - ${cleanQuality}`,
          title: `${movieTitle || 'Unknown Title'}\n${sizeInfo}`,
          url: finalDownloadUrl,
          quality: cachedLink.quality,
          size: sizeInfo,
          behaviorHints: { bingeGroup: `topmovies-${cleanQuality}` }
        };
      } catch (error) {
        console.error(`[TopMovies] Error processing cached link ${cachedLink.quality}: ${error.message}`);
        return null;
      }
    });

    const streams = (await Promise.all(streamPromises)).filter(Boolean);
    console.log(`[TopMovies] Successfully processed ${streams.length} final stream links.`);

    return streams;

  } catch (error) {
    console.error(`[TopMovies] A critical error occurred for TMDB ID ${tmdbId}: ${error.message}`);
    // For more detailed debugging, uncomment the line below
    // if (error.stack) console.error(error.stack);
    return [];
  }
}

module.exports = { getTopMoviesStreams };