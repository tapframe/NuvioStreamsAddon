const axios = require('axios');
const cheerio = require('cheerio');
const FormData = require('form-data');
const { CookieJar } = require('tough-cookie');
const { URLSearchParams, URL } = require('url');
const fs = require('fs').promises;
const path = require('path');
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

const TMDB_API_KEY = process.env.TMDB_API_KEY || "439c478a771f35c05022f9feabcca01c";

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'); // $& means the whole matched string
}

// Base64 decode utility function
function base64Decode(string) {
    try {
        const clean = string.trim().replace(/\n/g, '').replace(/\r/g, '');
        const padded = clean.padEnd(Math.ceil(clean.length / 4) * 4, '=');
        return Buffer.from(padded, 'base64').toString('utf-8');
    } catch (error) {
        console.error('[DramaDrip] Base64 decode error:', error.message);
        return '';
    }
}

// Helper function to get base URL
function getBaseUrl(url) {
    try {
        const urlObj = new URL(url);
        return `${urlObj.protocol}//${urlObj.host}`;
    } catch (error) {
        console.error('[DramaDrip] Error getting base URL:', error.message);
        return '';
    }
}

// Helper function to fix URLs
function fixUrl(url, domain) {
    if (url.startsWith('http')) {
        return url;
    }
    if (url === '') {
        return '';
    }
    if (url.startsWith('//')) {
        return 'https:' + url;
    } else {
        if (url.startsWith('/')) {
            return domain + url;
        }
        return domain + '/' + url;
    }
}

// Bypass function for hrefli/unblockedgames/examzculture links
async function bypassHrefli(url) {
    try {
        console.log(`[DramaDrip] Bypassing hrefli link: ${url}`);
        const host = getBaseUrl(url);

        // First request to get initial form
        let response = await makeRequest(url);
        let $ = cheerio.load(response.data);

        // Extract form data
        const formUrl = $('form#landing').attr('action');
        const formData = {};
        $('form#landing input').each((i, el) => {
            const name = $(el).attr('name');
            const value = $(el).attr('value');
            if (name) formData[name] = value;
        });

        if (!formUrl || Object.keys(formData).length === 0) {
            console.error('[DramaDrip] Could not extract initial form data');
            return null;
        }

        // Second request - POST to form action
        response = await axios.post(formUrl, new URLSearchParams(formData).toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        $ = cheerio.load(response.data);

        // Extract second form data
        const formUrl2 = $('form#landing').attr('action');
        const formData2 = {};
        $('form#landing input').each((i, el) => {
            const name = $(el).attr('name');
            const value = $(el).attr('value');
            if (name) formData2[name] = value;
        });

        // Third request - POST to second form action
        response = await axios.post(formUrl2, new URLSearchParams(formData2).toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        $ = cheerio.load(response.data);

        // Extract skToken from script
        const scriptContent = $('script').filter((i, el) => $(el).html().includes('?go=')).html();
        if (!scriptContent) {
            console.error('[DramaDrip] Could not find script with ?go=');
            return null;
        }

        const skToken = scriptContent.substring(scriptContent.indexOf('?go=') + 4).split('"')[0];
        if (!skToken) {
            console.error('[DramaDrip] Could not extract skToken');
            return null;
        }

        // Fourth request - GET with cookie
        const driveUrl = await axios.get(`${host}?go=${skToken}`, {
            headers: {
                'Cookie': `${skToken}=${formData2['_wp_http2']}`
            }
        }).then(res => {
            $ = cheerio.load(res.data);
            return $('meta[http-equiv="refresh"]').attr('content')?.split('url=')[1];
        });

        if (!driveUrl) {
            console.error('[DramaDrip] Could not extract drive URL');
            return null;
        }

        // Fifth request - GET drive URL and extract path
        const finalResponse = await makeRequest(driveUrl);
        const pathMatch = finalResponse.data.match(/replace\("([^"]+)"/);
        if (!pathMatch) {
            console.error('[DramaDrip] Could not extract path from final response');
            return null;
        }

        const path = pathMatch[1];
        if (path === '/404') return null;

        return fixUrl(path, getBaseUrl(driveUrl));

    } catch (error) {
        console.error(`[DramaDrip] Error in bypassHrefli: ${error.message}`);
        return null;
    }
}

// Full bypass function for cinematickit safelink= URLs
async function cinematickitBypass(url) {
    try {
        console.log(`[DramaDrip] Bypassing cinematickit link: ${url}`);
        const cleanedUrl = url.replace('&#038;', '&');
        const encodedLink = cleanedUrl.split('safelink=')[1]?.split('-')[0];

        if (!encodedLink) {
            console.error('[DramaDrip] Could not extract encoded link from safelink=');
            return null;
        }

        const decodedUrl = base64Decode(encodedLink);
        if (!decodedUrl) {
            console.error('[DramaDrip] Could not decode base64 link');
            return null;
        }

        const response = await makeRequest(decodedUrl);
        const $ = cheerio.load(response.data);

        const goValue = $('form#landing input[name=go]').attr('value');
        if (!goValue) {
            console.error('[DramaDrip] Could not find go value in form');
            return null;
        }

        const decodedGoUrl = base64Decode(goValue).replace('&#038;', '&');
        if (!decodedGoUrl) {
            console.error('[DramaDrip] Could not decode go value');
            return null;
        }

        const finalResponse = await makeRequest(decodedGoUrl);
        const final$ = cheerio.load(finalResponse.data);

        const script = final$('script').filter((i, el) => final$(el).html().includes('window.location.replace')).html();
        if (!script) {
            console.error('[DramaDrip] Could not find redirect script');
            return null;
        }

        const regex = /window\.location\.replace\s*\(\s*["'](.+?)["']\s*\)\s*;?/;
        const match = script.match(regex);
        if (!match) {
            console.error('[DramaDrip] Could not extract redirect path from script');
            return null;
        }

        const redirectPath = match[1];
        if (redirectPath.startsWith('http')) {
            return redirectPath;
        } else {
            const urlObj = new URL(decodedGoUrl);
            return `${urlObj.protocol}//${urlObj.host}${redirectPath}`;
        }

    } catch (error) {
        console.error(`[DramaDrip] Error in cinematickitBypass: ${error.message}`);
        return null;
    }
}

// Partial bypass function for cinematickit safelink= URLs (only decodes go value)
async function cinematickitloadBypass(url) {
    try {
        console.log(`[DramaDrip] Partially bypassing cinematickit link: ${url}`);
        const cleanedUrl = url.replace('&#038;', '&');
        const encodedLink = cleanedUrl.split('safelink=')[1]?.split('-')[0];

        if (!encodedLink) {
            console.error('[DramaDrip] Could not extract encoded link from safelink=');
            return null;
        }

        const decodedUrl = base64Decode(encodedLink);
        if (!decodedUrl) {
            console.error('[DramaDrip] Could not decode base64 link');
            return null;
        }

        const response = await makeRequest(decodedUrl);
        const $ = cheerio.load(response.data);

        const goValue = $('form#landing input[name=go]').attr('value');
        console.log(`[DramaDrip] Extracted go value: ${goValue}`);

        if (!goValue) {
            console.error('[DramaDrip] Could not find go value in form');
            return null;
        }

        return base64Decode(goValue).replace('&#038;', '&');

    } catch (error) {
        console.error(`[DramaDrip] Error in cinematickitloadBypass: ${error.message}`);
        return null;
    }
}

// --- Domain Fetching ---
let dramaDripDomain = 'https://dramadrip.com'; // Fallback domain
let domainCacheTimestamp = 0;
const DOMAIN_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

async function getDramaDripDomain() {
    const now = Date.now();
    if (now - domainCacheTimestamp < DOMAIN_CACHE_TTL) {
        return dramaDripDomain;
    }

    try {
        console.log('[DramaDrip] Fetching latest domain...');
        const response = await makeRequest('https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json', { timeout: 10000 });
        if (response.data && response.data.dramadrip) {
            dramaDripDomain = response.data.dramadrip;
            domainCacheTimestamp = now;
            console.log(`[DramaDrip] Updated domain to: ${dramaDripDomain}`);
        } else {
            console.warn('[DramaDrip] Domain JSON fetched, but "dramadrip" key was not found. Using fallback.');
        }
    } catch (error) {
        console.error(`[DramaDrip] Failed to fetch latest domain, using fallback. Error: ${error.message}`);
    }
    return dramaDripDomain;
}

// --- Proxy Configuration ---
const DRAMADRIP_PROXY_URL = process.env.DRAMADRIP_PROXY_URL;
if (DRAMADRIP_PROXY_URL) {
  console.log(`[DramaDrip] Proxy support enabled: ${DRAMADRIP_PROXY_URL}`);
} else {
  console.log('[DramaDrip] No proxy configured, using direct connections');
}

// --- Cache Configuration ---
const CACHE_ENABLED = process.env.DISABLE_CACHE !== 'true';
const CACHE_DIR = process.env.VERCEL ? path.join('/tmp', '.dramadrip_cache') : path.join(__dirname, '.cache', 'dramadrip');
// --- Caching Helper Functions ---
const ensureCacheDir = async () => {
    if (!CACHE_ENABLED) return;
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') console.error(`[DramaDrip Cache] Error creating cache directory: ${error.message}`);
    }
};

// Initialize Redis cache
const redisCache = new RedisCache('DramaDrip');

const getFromCache = async (key) => {
    if (!CACHE_ENABLED) return null;
    
    // Try Redis cache first, then fallback to file system
    const cachedData = await redisCache.getFromCache(key, '', CACHE_DIR);
    if (cachedData) {
        return cachedData;
    }
    
    return null;
};

const saveToCache = async (key, data) => {
    if (!CACHE_ENABLED) return;
    
    // Save to both Redis and file system
    await redisCache.saveToCache(key, data, '', CACHE_DIR);
};



// Initialize cache directory
ensureCacheDir();

// Proxy wrapper function
const makeRequest = async (url, options = {}) => {
  if (DRAMADRIP_PROXY_URL) {
    // Route through proxy
    const proxiedUrl = `${DRAMADRIP_PROXY_URL}${encodeURIComponent(url)}`;
    console.log(`[DramaDrip] Making proxied request to: ${url}`);
    return axios.get(proxiedUrl, options);
  } else {
    // Direct request
    console.log(`[DramaDrip] Making direct request to: ${url}`);
    return axios.get(url, options);
  }
};

// Helper function to create a proxied session for SID resolution
// Helper function to extract cookies from jar for a specific URL
const getCookiesForUrl = async (jar, url) => {
  try {
    const cookies = await jar.getCookies(url);
    return cookies.map(cookie => cookie.toString()).join('; ');
  } catch (error) {
    console.error(`[DramaDrip] Error extracting cookies: ${error.message}`);
    return '';
  }
};

const createProxiedSession = async (jar) => {
  const { wrapper } = await getAxiosCookieJarSupport();
  
  const sessionConfig = {
    jar,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'en-US,en;q=0.5',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    }
  };

  const session = wrapper(axios.create(sessionConfig));

  // If proxy is enabled, wrap the session methods to use proxy
  if (DRAMADRIP_PROXY_URL) {
    console.log(`[DramaDrip] Creating SID session with proxy: ${DRAMADRIP_PROXY_URL}`);
    const originalGet = session.get.bind(session);
    const originalPost = session.post.bind(session);

    session.get = async (url, options = {}) => {
      const proxiedUrl = `${DRAMADRIP_PROXY_URL}${encodeURIComponent(url)}`;
      console.log(`[DramaDrip] Making proxied SID GET request to: ${url}`);
      
      // Extract cookies from jar and add to headers
      const cookieString = await getCookiesForUrl(jar, url);
      if (cookieString) {
        console.log(`[DramaDrip] Adding cookies to proxied request: ${cookieString}`);
        options.headers = {
          ...options.headers,
          'Cookie': cookieString
        };
      }
      
      return originalGet(proxiedUrl, options);
    };

    session.post = async (url, data, options = {}) => {
      const proxiedUrl = `${DRAMADRIP_PROXY_URL}${encodeURIComponent(url)}`;
      console.log(`[DramaDrip] Making proxied SID POST request to: ${url}`);
      
      // Extract cookies from jar and add to headers
      const cookieString = await getCookiesForUrl(jar, url);
      if (cookieString) {
        console.log(`[DramaDrip] Adding cookies to proxied request: ${cookieString}`);
        options.headers = {
          ...options.headers,
          'Cookie': cookieString
        };
      }
      
      return originalPost(proxiedUrl, data, options);
    };
  }

  return session;
};

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
        const baseUrl = await getDramaDripDomain();
        const searchUrl = `${baseUrl}/?s=${encodeURIComponent(query)}`;
        console.log(`[DramaDrip] Searching for: "${query}"`);
        const { data } = await makeRequest(searchUrl);
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
        const { data } = await makeRequest(url);
        const $ = cheerio.load(data);
        
        // Check for TV show season headers first
        const seasonHeaders = $('h2.wp-block-heading:contains("Season")');
        if (seasonHeaders.length > 0) {
            console.log('[DramaDrip] TV show detected. Extracting seasons...');
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
            return { type: 'tv', data: seasons };
        }

        // If no season headers, assume it's a movie
        console.log('[DramaDrip] Movie detected. Extracting download qualities...');
        const qualities = [];
        $('.su-spoiler-content .wp-block-button a').each((i, el) => {
            const link = $(el);
            const qualityText = link.text().trim();
            const linkUrl = link.attr('href');
            if (linkUrl) {
                qualities.push({ quality: qualityText, url: linkUrl });
            }
        });

        if (qualities.length > 0) {
            return { type: 'movie', data: qualities };
        }
        
        console.log('[DramaDrip] Could not find any TV seasons or movie download links.');
        return null;

    } catch (error) {
        console.error(`[DramaDrip] Error extracting links: ${error.message}`);
        return null;
    }
}

// Resolves intermediate links from cinematickit.org or episodes.modpro.blog
async function resolveCinemaKitOrModproLink(initialUrl, refererUrl) {
    try {
        // Handle safelink= URLs by bypassing them first
        let actualUrl = initialUrl;
        if (initialUrl.includes('safelink=')) {
            console.log(`[DramaDrip] Detected safelink URL, bypassing: ${initialUrl}`);
            actualUrl = await cinematickitloadBypass(initialUrl);
            if (!actualUrl) {
                console.error('[DramaDrip] Failed to bypass safelink URL');
                return null;
            }
            console.log(`[DramaDrip] Bypassed to: ${actualUrl}`);
        }

        const { data } = await makeRequest(actualUrl, { headers: { 'Referer': refererUrl } });
        const $ = cheerio.load(data);
        const finalLinks = [];
        
        // Try TV show selectors first
        let episodeLinks = $('.entry-content h3:contains("Episode") a');
        if (episodeLinks.length > 0) {
            episodeLinks.each((i, el) => {
                const link = $(el).attr('href');
                const text = $(el).text().trim();
                const isSupported = link && (link.includes('driveseed.org') || link.includes('tech.unblockedgames.world') || link.includes('tech.creativeexpressionsblog.com') || link.includes('tech.examzculture.in'));
                if (isSupported && text && !text.toLowerCase().includes('batch') && !text.toLowerCase().includes('zip')) {
                    finalLinks.push({ type: 'episode', name: text.replace(/\s+/g, ' '), url: link });
                }
            });
            return { type: 'episodes', links: finalLinks };
        }

        let seriesBtnLinks = $('.wp-block-button.series_btn a');
        if (seriesBtnLinks.length > 0) {
            seriesBtnLinks.each((i, el) => {
                const link = $(el).attr('href');
                const text = $(el).text().trim();
                const isSupported = link && (link.includes('driveseed.org') || link.includes('tech.unblockedgames.world') || link.includes('tech.creativeexpressionsblog.com') || link.includes('tech.examzculture.in'));
                if (isSupported && text && !text.toLowerCase().includes('batch') && !text.toLowerCase().includes('zip')) {
                     finalLinks.push({ type: 'episode', name: text.replace(/\s+/g, ' '), url: link });
                }
            });
            return { type: 'episodes', links: finalLinks };
        }

        // Fallback to movie selector
        $('.wp-block-button.movie_btn a').each((i, el) => {
             const link = $(el).attr('href');
             const text = $(el).text().trim();
             const isSupported = link && (link.includes('driveseed.org') || link.includes('tech.unblockedgames.world') || link.includes('tech.creativeexpressionsblog.com') || link.includes('tech.examzculture.in'));
             if(isSupported && text) {
                finalLinks.push({ type: 'server', name: text, url: link });
             }
        });

        if(finalLinks.length > 0) {
            return { type: 'servers', links: finalLinks };
        }

        return null; // No links found

    } catch (error) {
        console.error(`[DramaDrip] Error resolving intermediate link: ${error.message}`);
        return null;
    }
}

// Function to resolve tech.unblockedgames.world links to driveleech URLs (adapted from moviesmod.js)
async function resolveTechUnblockedLink(sidUrl) {
  console.log(`[DramaDrip] Resolving SID link: ${sidUrl}`);
  const { origin } = new URL(sidUrl);
  const jar = new CookieJar();

  // Create session with proxy support
  const session = await createProxiedSession(jar);

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

// Resolves driveseed.org links to find download options
async function resolveDriveseedLink(driveseedUrl) {
    try {
        console.log(`[DramaDrip] Resolving Driveseed link: ${driveseedUrl}`);
        const { data } = await makeRequest(driveseedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Referer': 'https://links.modpro.blog/', 
            }
        });

        let finalData = data;
        let finalUrl = driveseedUrl;
        
        // Check if there's a JavaScript redirect
        const redirectMatch = data.match(/window\.location\.replace\("([^"]+)"\)/);
        if (redirectMatch && redirectMatch[1]) {
            const finalPath = redirectMatch[1];
            finalUrl = `https://driveseed.org${finalPath}`;
            console.log(`[DramaDrip] JS redirect found. Following to: ${finalUrl}`);
            
            const finalResponse = await makeRequest(finalUrl, {
                 headers: { 'Referer': driveseedUrl }
            });
            finalData = finalResponse.data;
        } else {
            console.log(`[DramaDrip] No redirect found, treating as final page: ${driveseedUrl}`);
        }
        
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
            const buttonTitle = button.text().trim();
            let type = 'unknown';
            if (buttonTitle.includes('Instant')) type = 'instant';
            if (buttonTitle.includes('Resume Cloud')) type = 'resume';
            if (buttonTitle.includes('Worker Bot')) type = 'worker';

            let url = button.attr('href');
            if (type === 'resume' && url && !url.startsWith('http')) {
                url = `https://driveseed.org${url}`;
            }
            if(url) downloadOptions.push({ title: buttonTitle, type, url });
        });

        console.log(`[DramaDrip] Found ${downloadOptions.length} download options for: ${title}`);
        return { downloadOptions, title, size };
    } catch (error) {
        console.error(`[DramaDrip] Error resolving Driveseed link: ${error.message}`);
        return null;
    }
}

// Environment variable to control URL validation
const URL_VALIDATION_ENABLED = process.env.DISABLE_URL_VALIDATION !== 'true';
console.log(`[DramaDrip] URL validation is ${URL_VALIDATION_ENABLED ? 'enabled' : 'disabled'}.`);

// Validate if a video URL is working (not 404 or broken)
async function validateVideoUrl(url, timeout = 10000) {
    // Skip validation if disabled via environment variable
    if (!URL_VALIDATION_ENABLED) {
        console.log(`[DramaDrip] URL validation disabled, skipping validation for: ${url.substring(0, 100)}...`);
        return true;
    }

    try {
        console.log(`[DramaDrip] Validating URL: ${url.substring(0, 100)}...`);
        
        // Use proxy for URL validation if enabled
        let response;
        if (DRAMADRIP_PROXY_URL) {
            const proxiedUrl = `${DRAMADRIP_PROXY_URL}${encodeURIComponent(url)}`;
            console.log(`[DramaDrip] Making proxied HEAD request for validation to: ${url}`);
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
            console.log(`[DramaDrip] ✓ URL validation successful (${response.status})`);
            return true;
        } else {
            console.log(`[DramaDrip] ✗ URL validation failed with status: ${response.status}`);
            return false;
        }
    } catch (error) {
        console.log(`[DramaDrip] ✗ URL validation failed: ${error.message}`);
        return false;
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
                
                let response;
                const videoSeedApiUrl = 'https://video-seed.pro/api';
                const postData = `keys=${keysParam}`;
                const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'x-token': 'video-seed.pro' };
                
                if (DRAMADRIP_PROXY_URL) {
                    const proxiedApiUrl = `${DRAMADRIP_PROXY_URL}${encodeURIComponent(videoSeedApiUrl)}`;
                    console.log(`[DramaDrip] Making proxied POST request to video-seed.pro API`);
                    response = await axios.post(proxiedApiUrl, postData, { headers });
                } else {
                    response = await axios.post(videoSeedApiUrl, postData, { headers });
                }
                
                return response.data ? response.data.url : null;

            case 'resume':
                const { data: resumeData } = await makeRequest(downloadOption.url, { headers: { 'Referer': 'https://driveseed.org/' } });
                return cheerio.load(resumeData)('a:contains("Cloud Resume Download")').attr('href');

            case 'worker':
                const workerJar = new CookieJar();
                
                // Create session with proxy support
                const workerSession = await createProxiedSession(workerJar);
                const { data: pageHtml } = await workerSession.get(downloadOption.url);
                
                const scriptContent = pageHtml.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/g).find(s => s.includes("formData.append('token'"));
                if (!scriptContent) return null;

                const tokenMatch = scriptContent.match(/formData\.append\('token', '([^']+)'\)/);
                const idMatch = scriptContent.match(/fetch\('\/download\?id=([^']+)',/);
                if (!tokenMatch || !idMatch) return null;

                const formData = new FormData();
                formData.append('token', tokenMatch[1]);
                const workerApiUrl = `https://workerseed.dev/download?id=${idMatch[1]}`;
                const { data: apiResponse } = await workerSession.post(workerApiUrl, formData, { headers: { ...formData.getHeaders(), 'x-requested-with': 'XMLHttpRequest' } });
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

    try {
        const cacheKey = `dramadrip_final_v15_${tmdbId}_${mediaType}${seasonNum ? `_s${seasonNum}e${episodeNum}` : ''}`;
        
        // 1. Check cache for resolved intermediate links
        let cachedLinks = await getFromCache(cacheKey);
        if (cachedLinks && cachedLinks.length > 0) {
            console.log(`[DramaDrip Cache] Using ${cachedLinks.length} cached intermediate links.`);
        } else {
            if (cachedLinks && cachedLinks.length === 0) {
                console.log(`[DramaDrip] Cache contains empty data for ${cacheKey}. Refetching from source.`);
            } else {
                console.log(`[DramaDrip Cache] MISS for key: ${cacheKey}. Fetching from source.`);
            }
            console.log(`[DramaDrip Cache] MISS for key: ${cacheKey}. Fetching from source.`);
            // 2. If cache miss, fetch from source
            const { data: tmdbData } = await axios.get(`https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${TMDB_API_KEY}`);
            const title = mediaType === 'tv' ? tmdbData.name : tmdbData.title;
            const year = mediaType === 'tv' ? (tmdbData.first_air_date || '').substring(0, 4) : (tmdbData.release_date || '').substring(0, 4);

            // --- ASIAN CONTENT FILTERING ---
            const asianCountries = [
                'JP', 'KR', 'CN', 'TH', 'TW', 'HK', 'SG', 'MY', 'ID', 'PH', 
                'VN', 'IN', 'BD', 'LK', 'NP', 'BT', 'MM', 'KH', 'LA', 'BN',
                'MN', 'KZ', 'UZ', 'KG', 'TJ', 'TM', 'AF', 'PK', 'MV', 'MO'
            ];
            
            const asianLanguages = [
                'ja', 'ko', 'zh', 'th', 'hi', 'ta', 'te', 'bn', 'ur', 'vi', 
                'id', 'ms', 'tl', 'my', 'km', 'lo', 'si', 'ne', 'dz', 'mn'
            ];
            
            // Primary indicators (most reliable)
            const originCountries = tmdbData.origin_country || [];
            const productionCountries = tmdbData.production_countries?.map(c => c.iso_3166_1) || [];
            const allCountries = [...new Set([...originCountries, ...productionCountries])];
            const originalLanguage = tmdbData.original_language;
            
            // Check primary indicators first
            const isPrimaryAsianCountry = allCountries.some(country => asianCountries.includes(country));
            const isPrimaryAsianLanguage = asianLanguages.includes(originalLanguage);
            
            // Secondary indicator (less reliable - only use if primary indicators are inconclusive)
            const spokenLanguages = tmdbData.spoken_languages?.map(l => l.iso_639_1) || [];
            const hasAsianSpokenLanguage = spokenLanguages.some(lang => asianLanguages.includes(lang));
            
            // Strict filtering logic:
            // 1. If primary country is non-Asian (US, GB, etc.), reject even if has Asian spoken languages
            // 2. Only accept if primary country OR primary language is Asian
            // 3. Use spoken languages only if no clear primary indicators exist
            
            const nonAsianMajorCountries = ['US', 'GB', 'CA', 'AU', 'FR', 'DE', 'IT', 'ES', 'RU', 'BR', 'MX'];
            const isPrimaryNonAsian = allCountries.some(country => nonAsianMajorCountries.includes(country));
            
            let isAsianContent = false;
            let reason = '';
            
            if (isPrimaryNonAsian && !isPrimaryAsianCountry) {
                // Definitely non-Asian (e.g., US movie with some Chinese dialogue)
                isAsianContent = false;
                reason = `Primary non-Asian country detected (${allCountries.join(', ')})`;
            } else if (isPrimaryAsianCountry) {
                // Definitely Asian by country
                isAsianContent = true;
                reason = `Asian production country (${allCountries.join(', ')})`;
            } else if (isPrimaryAsianLanguage) {
                // Definitely Asian by original language
                isAsianContent = true;
                reason = `Asian original language (${originalLanguage})`;
            } else if (allCountries.length === 0 && hasAsianSpokenLanguage && !originalLanguage) {
                // Fallback: no country/original language data, but has Asian spoken language
                isAsianContent = true;
                reason = `Asian spoken language fallback (${spokenLanguages.join(', ')})`;
            } else {
                isAsianContent = false;
                reason = `No clear Asian indicators (Countries: ${allCountries.join(', ') || 'None'}, Original: ${originalLanguage || 'None'})`;
            }
            
            if (!isAsianContent) {
                console.log(`[DramaDrip] Skipping non-Asian content: "${title}" - ${reason}`);
                await saveToCache(cacheKey, []); // Cache empty result
                return [];
            }
            
            console.log(`[DramaDrip] ✓ Asian content detected: "${title}" - ${reason}`);
            console.log(`[DramaDrip] Searching for: "${title}" (${year})`);
            const searchResults = await searchDramaDrip(title);
            if (searchResults.length === 0) throw new Error(`No search results found for "${title}"`);

            // --- NEW: Use string similarity to find the best match ---
            const titles = searchResults.map(r => r.title);
            const bestMatch = findBestMatch(title, titles);
            
            console.log(`[DramaDrip] Best match for "${title}" is "${bestMatch.bestMatch.target}" with a rating of ${bestMatch.bestMatch.rating.toFixed(2)}`);

            let selectedResult = null;
            // Set a minimum confidence threshold
            if (bestMatch.bestMatch.rating > 0.3) {
                const bestResult = searchResults[bestMatch.bestMatchIndex];
                // For movies, double-check the year if available
                if (mediaType === 'movie' && year && bestResult.year && bestResult.year !== year) {
                     console.log(`[DramaDrip] Similarity match found, but year (${bestResult.year}) does not match expected year (${year}). Rejecting.`);
                } else {
                    selectedResult = bestResult;
                }
            }

            // --- FALLBACK: If similarity check fails, use a stricter regex search ---
            if (!selectedResult) {
                console.log(`[DramaDrip] Similarity match failed or was rejected. Falling back to stricter regex search.`);
                const cleanedTitle = escapeRegExp(title.toLowerCase());
                const titleRegex = new RegExp(`\\b${cleanedTitle}\\b`, 'i');

                selectedResult = searchResults.find(r => {
                    const lowerCaseResultTitle = r.title.toLowerCase();
                    if (!titleRegex.test(lowerCaseResultTitle)) return false;
                    
                    if (mediaType === 'movie' && year && r.year) {
                        return r.year === year;
                    } else if (mediaType === 'tv') {
                        // For TV shows, just matching the title is usually enough,
                        // as they often appear as "Show Title Season 1-3" etc.
                        return lowerCaseResultTitle.includes('season');
                    }
                    return true; // For movies without a year to check
                });
            }

            if (!selectedResult) {
                console.log(`[DramaDrip] All matching attempts failed for "${title}" (${year})`);
                return [];
            }
    
            console.log(`[DramaDrip] Selected result: "${selectedResult.title}" (${selectedResult.url})`);
            const extractedContent = await extractDramaDripLinks(selectedResult.url);
            if(!extractedContent) return [];

            let qualitiesToResolve = [];
            if(mediaType === 'tv' && extractedContent.type === 'tv') {
                const targetSeason = extractedContent.data.find(s => s.seasonTitle.includes(`Season ${seasonNum}`) && !s.seasonTitle.toLowerCase().includes('zip'));
                if (targetSeason) {
                    qualitiesToResolve = targetSeason.qualities.filter(q => !q.quality.includes('480p'));
                }
            } else if (mediaType === 'movie' && extractedContent.type === 'movie') {
                qualitiesToResolve = extractedContent.data.filter(q => !q.quality.includes('480p'));
            }

            if (qualitiesToResolve.length === 0) return [];

            // 3. Resolve to driveseed redirect URLs (intermediate step) for caching
            const resolutionPromises = qualitiesToResolve.map(async (quality) => {
                try {
                    const intermediateResult = await resolveCinemaKitOrModproLink(quality.url, selectedResult.url);
                    if (!intermediateResult) return null;

                    let targetUrl = null;
                    if (mediaType === 'tv' && intermediateResult.type === 'episodes') {
                        const targetEpisode = intermediateResult.links.find(e => e.name.includes(`Episode ${episodeNum}`));
                        if (targetEpisode) targetUrl = targetEpisode.url;
                    } else if (mediaType === 'movie' && intermediateResult.type === 'servers') {
                        const fastServer = intermediateResult.links.find(s => s.name.includes('Server 1')) || intermediateResult.links[0];
                        if (fastServer) targetUrl = fastServer.url;
                    }

                    if (!targetUrl) return null;

                    // Handle SID links first
                    if (targetUrl.includes('tech.unblockedgames.world') || targetUrl.includes('tech.creativeexpressionsblog.com') || targetUrl.includes('tech.examzculture.in')) {
                        const resolvedUrl = await bypassHrefli(targetUrl);
                        if (!resolvedUrl) return null;
                        targetUrl = resolvedUrl;
                    }

                    if (!targetUrl || !targetUrl.includes('driveseed.org')) return null;

                    console.log(`[DramaDrip] Caching driveseed redirect URL for ${quality.quality}: ${targetUrl}`);
                    return { ...quality, driveseedRedirectUrl: targetUrl };
                } catch (error) {
                    console.error(`[DramaDrip] Error resolving quality ${quality.quality}: ${error.message}`);
                    return null;
                }
            });
            
            cachedLinks = (await Promise.all(resolutionPromises)).filter(Boolean);

            // 4. Save to cache
            if (cachedLinks.length > 0) {
                console.log(`[DramaDrip] Caching ${cachedLinks.length} resolved driveseed redirect URLs for key: ${cacheKey}`);
                await saveToCache(cacheKey, cachedLinks);
            }
        }

        if (!cachedLinks || cachedLinks.length === 0) {
            console.log('[DramaDrip] No driveseed redirect URLs found after scraping/cache check.');
            return [];
        }

        // 5. Process cached driveseed redirect URLs to get final streams
        console.log(`[DramaDrip] Processing ${cachedLinks.length} cached driveseed redirect URLs to get final streams.`);
        const streamPromises = cachedLinks.map(async (linkInfo) => {
            try {
                const { driveseedRedirectUrl } = linkInfo;
                if (!driveseedRedirectUrl) return null;

                // Resolve redirect to final file page using shared util
                const resFollow = await followRedirectToFilePage({
                    redirectUrl: driveseedRedirectUrl,
                    get: (url, opts) => makeRequest(url, opts),
                    log: console
                });
                const $ = resFollow.$;
                const finalFilePageUrl = resFollow.finalFilePageUrl;
                console.log(`[DramaDrip] Resolved redirect to final file page: ${finalFilePageUrl}`);
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
                    const buttonTitle = button.text().trim();
                    let type = 'unknown';
                    if (buttonTitle.includes('Instant')) type = 'instant';
                    if (buttonTitle.includes('Resume Cloud')) type = 'resume';
                    if (buttonTitle.includes('Worker Bot')) type = 'worker';

                    let url = button.attr('href');
                    if (type === 'resume' && url && !url.startsWith('http')) {
                        url = `https://driveseed.org${url}`;
                    }
                    if(url) downloadOptions.push({ title: buttonTitle, type, url });
                });

                // Use shared util to extract final link from file page
                const origin = new URL(finalFilePageUrl).origin;
                const finalLink = await extractFinalDownloadFromFilePage($, {
                    origin,
                    get: (url, opts) => makeRequest(url, opts),
                    post: (url, data, opts) => axios.post(url, data, opts),
                    validate: (url) => validateVideoUrl(url),
                    log: console
                });

                if (finalLink) {
                    const fileTitle = title;
                    const fileSize = size;
                    return {
                        name: `DramaDrip - ${linkInfo.quality.split('(')[0].trim()}`,
                        title: `${fileTitle || "Unknown Title"}\n${fileSize || 'Unknown Size'}`,
                        url: finalLink,
                        quality: linkInfo.quality,
                        size: fileSize || '0'
                    };
                }

                console.log(`[DramaDrip] ✗ Could not extract final link for ${linkInfo.quality}`);
                return null;
            } catch (e) {
                console.error(`[DramaDrip] Error in stream promise: ${e.message}`);
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