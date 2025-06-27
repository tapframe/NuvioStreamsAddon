const axios = require('axios');
const cheerio = require('cheerio');
const { URLSearchParams, URL } = require('url');
const FormData = require('form-data');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const fs = require('fs').promises;
const path = require('path');

// Constants
const BASE_URL = 'https://uhdmovies.email';
const TMDB_API_KEY_UHDMOVIES = "439c478a771f35c05022f9feabcca01c"; // Public TMDB API key

// --- Caching Configuration ---
const CACHE_ENABLED = process.env.DISABLE_CACHE !== 'true'; // Set to true to disable caching for this provider
console.log(`[UHDMovies] Internal cache is ${CACHE_ENABLED ? 'enabled' : 'disabled'}.`);
const CACHE_DIR = path.join(__dirname, '.cache', 'uhdmovies'); // Cache directory inside providers/uhdmovies
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours in milliseconds

// --- Caching Helper Functions ---
const ensureCacheDir = async () => {
    if (!CACHE_ENABLED) return;
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') {
            console.error(`[UHDMovies Cache] Error creating cache directory: ${error.message}`);
        }
    }
};

const getFromCache = async (key) => {
    if (!CACHE_ENABLED) return null;
    const cacheFile = path.join(CACHE_DIR, `${key}.json`);
    try {
        const data = await fs.readFile(cacheFile, 'utf-8');
        const cached = JSON.parse(data);

        if (Date.now() > cached.expiry) {
            console.log(`[UHDMovies Cache] EXPIRED for key: ${key}`);
            await fs.unlink(cacheFile).catch(() => {});
            return null;
        }

        console.log(`[UHDMovies Cache] HIT for key: ${key}`);
        return cached.data;
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error(`[UHDMovies Cache] READ ERROR for key ${key}: ${error.message}`);
        }
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
        console.log(`[UHDMovies Cache] SAVED for key: ${key}`);
    } catch (error) {
        console.error(`[UHDMovies Cache] WRITE ERROR for key ${key}: ${error.message}`);
    }
};

// Initialize cache directory on startup
ensureCacheDir();

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
  timeout: 30000
});

// Simple In-Memory Cache
const uhdMoviesCache = {
  search: {},
  movie: {},
  show: {}
};

// Function to search for movies
async function searchMovies(query) {
  try {
    console.log(`[UHDMovies] Searching for: ${query}`);
    const searchUrl = `${BASE_URL}/search/${encodeURIComponent(query)}`;
    
    const response = await axiosInstance.get(searchUrl);
    const $ = cheerio.load(response.data);
    
    const searchResults = [];
    
    // Find all search result items
    $('a[href*="/download-"]').each((index, element) => {
      const link = $(element).attr('href');
      // Avoid duplicates by checking if link already exists in results
      if (link && !searchResults.some(item => item.link === link)) {
        const title = $(element).text().trim();
         if(title){
            searchResults.push({
                title,
                link: link.startsWith('http') ? link : `${BASE_URL}${link}`
            });
         }
      }
    });
    
    console.log(`[UHDMovies] Found ${searchResults.length} results`);
    return searchResults;
  } catch (error) {
    console.error(`[UHDMovies] Error searching movies: ${error.message}`);
    return [];
  }
}

// Function to extract clean quality information from verbose text
function extractCleanQuality(fullQualityText) {
  if (!fullQualityText || fullQualityText === 'Unknown Quality') {
    return 'Unknown Quality';
  }
  
  const cleanedFullQualityText = fullQualityText.replace(/(\u00a9|\u00ae|[\u2000-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff])/g, '').trim();
  const text = cleanedFullQualityText.toLowerCase();
  let quality = [];
  
  // Extract resolution
  if (text.includes('2160p') || text.includes('4k')) {
    quality.push('4K');
  } else if (text.includes('1080p')) {
    quality.push('1080p');
  } else if (text.includes('720p')) {
    quality.push('720p');
  } else if (text.includes('480p')) {
    quality.push('480p');
  }
  
  // Extract special features
  if (text.includes('hdr')) {
    quality.push('HDR');
  }
  if (text.includes('dolby vision') || text.includes('dovi') || /\bdv\b/.test(text)) {
    quality.push('DV');
  }
  if (text.includes('imax')) {
    quality.push('IMAX');
  }
  if (text.includes('bluray') || text.includes('blu-ray')) {
    quality.push('BluRay');
  }
  
  // If we found any quality indicators, join them
  if (quality.length > 0) {
    return quality.join(' | ');
  }
  
  // Fallback: try to extract a shorter version of the original text
  // Look for patterns like "Movie Name (Year) Resolution ..."
  const patterns = [
    /(\d{3,4}p.*?(?:x264|x265|hevc).*?)[\[\(]/i,
    /(\d{3,4}p.*?)[\[\(]/i,
    /((?:720p|1080p|2160p|4k).*?)$/i
  ];
  
  for (const pattern of patterns) {
    const match = cleanedFullQualityText.match(pattern);
    if (match && match[1].trim().length < 100) {
      return match[1].trim().replace(/x265/ig, 'HEVC');
    }
  }
  
  // Final fallback: truncate if too long
  if (cleanedFullQualityText.length > 80) {
    return cleanedFullQualityText.substring(0, 77).replace(/x265/ig, 'HEVC') + '...';
  }
  
  return cleanedFullQualityText.replace(/x265/ig, 'HEVC');
}

// Function to extract download links for TV shows from a page
async function extractTvShowDownloadLinks(showPageUrl, season, episode) {
  try {
    console.log(`[UHDMovies] Extracting TV show links from: ${showPageUrl} for S${season}E${episode}`);
    const response = await axiosInstance.get(showPageUrl);
    const $ = cheerio.load(response.data);

    const showTitle = $('h1').first().text().trim();
    const downloadLinks = [];

    // New, more robust scanning logic
    const qualityHeaders = $('.entry-content').find('pre, p:has(strong), p:has(b), h3, h4');

    qualityHeaders.each((index, header) => {
        const $header = $(header);
        let qualityText = $header.text().trim();

        // Filter out irrelevant headers and sections
        if (qualityText.length < 4 || qualityText.length > 250 || /plot|download|screenshot|trailer|join|powered by/i.test(qualityText)) {
            return; // = continue to the next iteration
        }

        let linksParagraph = null;
        let currentElement = $header;

        // Scan the next few sibling elements to find the link paragraph
        for (let i = 0; i < 3; i++) { 
            currentElement = currentElement.next();
            if (!currentElement.length) break;

            const currentText = currentElement.text().trim();
            
            // If the sibling looks like another quality header, we've gone too far.
            if (i > 0 && currentElement.is('pre, h3, h4')) break;
            if (i > 0 && currentElement.is('p') && currentElement.find('strong, b').length > 0 && /p|4k|hevc/i.test(currentText)) break;
            
            // If the element is a paragraph and has the download links, we've found our target.
            if (currentElement.is('p') && currentElement.find('a[href*="tech.unblockedgames.world"]').length > 0) {
                linksParagraph = currentElement;
                break;
            }

            // If it's a paragraph without links, it's likely more quality info. Append it.
            if (currentElement.is('p') && currentText) {
                qualityText += ' ' + currentText;
            }
        }

        if (linksParagraph) {
            const episodeRegex = new RegExp(`^Episode\\s+0*${episode}(?!\\d)`, 'i');
            const targetEpisodeLink = linksParagraph.find('a').filter((i, el) => {
                return episodeRegex.test($(el).text().trim());
            }).first();
            
            if (targetEpisodeLink.length > 0) {
                const link = targetEpisodeLink.attr('href');
                if (link && !downloadLinks.some(item => item.link === link)) {
                    const sizeMatch = qualityText.match(/\[\s*([0-9.,]+\s*[KMGT]B)/i);
                    const size = sizeMatch ? sizeMatch[1] : 'Unknown';

                    const cleanQuality = extractCleanQuality(qualityText);
                    downloadLinks.push({ quality: cleanQuality, size: size, link: link });
                }
            }
        }
    });

    if (downloadLinks.length > 0) {
      console.log(`[UHDMovies] Found ${downloadLinks.length} links using primary scan.`);
    } else {
      console.log(`[UHDMovies] Primary scan failed to find links.`);
    }
    
    return { title: showTitle, links: downloadLinks };

  } catch (error) {
    console.error(`[UHDMovies] Error extracting TV show download links: ${error.message}`);
    return { title: 'Unknown', links: [] };
  }
}

// Function to extract download links from a movie page
async function extractDownloadLinks(moviePageUrl) {
  try {
    console.log(`[UHDMovies] Extracting links from: ${moviePageUrl}`);
    const response = await axiosInstance.get(moviePageUrl);
    const $ = cheerio.load(response.data);
    
    const movieTitle = $('h1').first().text().trim();
    const downloadLinks = [];
    
    // Find all download links (the new SID links) and their associated quality information
    $('a[href*="tech.unblockedgames.world"]').each((index, element) => {
      const link = $(element).attr('href');
      
      if (link && !downloadLinks.some(item => item.link === link)) {
        let quality = 'Unknown Quality';
        let size = 'Unknown';
        
        // Method 1: Look for quality in the closest preceding paragraph or heading
        const prevElement = $(element).closest('p').prev();
        if (prevElement.length > 0) {
          const prevText = prevElement.text().trim();
          if (prevText && prevText.length > 20 && !prevText.includes('Download')) {
            quality = prevText;
          }
        }
        
        // Method 2: Look for quality in parent's siblings
        if (quality === 'Unknown Quality') {
          const parentSiblings = $(element).parent().prevAll().first().text().trim();
          if (parentSiblings && parentSiblings.length > 20) {
            quality = parentSiblings;
          }
        }
        
        // Method 3: Look for bold/strong text above the link
        if (quality === 'Unknown Quality') {
          const strongText = $(element).closest('p').prevAll().find('strong, b').last().text().trim();
          if (strongText && strongText.length > 20) {
            quality = strongText;
          }
        }
        
        // Method 4: Look for the entire paragraph containing quality info
        if (quality === 'Unknown Quality') {
          let currentElement = $(element).parent();
          for (let i = 0; i < 5; i++) {
            currentElement = currentElement.prev();
            if (currentElement.length === 0) break;
            
            const text = currentElement.text().trim();
            if (text && text.length > 30 && 
                (text.includes('1080p') || text.includes('720p') || text.includes('2160p') || 
                 text.includes('4K') || text.includes('HEVC') || text.includes('x264') || text.includes('x265'))) {
              quality = text;
              break;
            }
          }
        }
        
        // Extract size from quality text if present
        const sizeMatch = quality.match(/\[([0-9.,]+\s*[KMGT]B[^\]]*)\]/);
        if (sizeMatch) {
          size = sizeMatch[1];
        }
        
        // Clean up the quality information
        const cleanQuality = extractCleanQuality(quality);
        
        downloadLinks.push({
          quality: cleanQuality,
          size: size,
          link: link,
          rawQuality: quality.replace(/(\r\n|\n|\r)/gm," ").replace(/\s+/g, ' ').trim()
        });
      }
    });
    
    return {
      title: movieTitle,
      links: downloadLinks
    };
    
  } catch (error) {
    console.error(`[UHDMovies] Error extracting download links: ${error.message}`);
    return { title: 'Unknown', links: [] };
  }
}

function extractCodecs(rawQuality) {
    const codecs = [];
    const text = rawQuality.toLowerCase();

    if (text.includes('hevc') || text.includes('x265')) {
        codecs.push('H.265');
    } else if (text.includes('x264')) {
        codecs.push('H.264');
    }

    if (text.includes('10bit') || text.includes('10-bit')) {
        codecs.push('10-bit');
    }
    
    if (text.includes('atmos')) {
        codecs.push('Atmos');
    } else if (text.includes('dts-hd')) {
        codecs.push('DTS-HD');
    } else if (text.includes('dts')) {
        codecs.push('DTS');
    } else if (text.includes('ddp5.1') || text.includes('dd+ 5.1') || text.includes('eac3')) {
        codecs.push('EAC3');
    } else if (text.includes('ac3')) {
        codecs.push('AC3');
    }
    
    if (text.includes('dovi') || text.includes('dolby vision') || /\bdv\b/.test(text)) {
        codecs.push('DV');
    } else if (text.includes('hdr')) {
        codecs.push('HDR');
    }

    return codecs;
}

// Function to try Instant Download method
async function tryInstantDownload($) {
  const instantDownloadLink = $('a:contains("Instant Download")').attr('href');
  if (!instantDownloadLink) {
    return null;
  }

  console.log('[UHDMovies] Found "Instant Download" link, attempting to extract final URL...');
  
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
            // Fix spaces in workers.dev URLs by encoding them properly
            if (finalUrl.includes('workers.dev')) {
              const urlParts = finalUrl.split('/');
              const filename = urlParts[urlParts.length - 1];
              const encodedFilename = filename.replace(/ /g, '%20');
              urlParts[urlParts.length - 1] = encodedFilename;
              finalUrl = urlParts.join('/');
            }
            console.log('[UHDMovies] Extracted final link from API:', finalUrl);
            return finalUrl;
        }
    }
    
    console.log('[UHDMovies] Could not find a valid final download link from Instant Download.');
    return null;
  } catch (error) {
    console.log(`[UHDMovies] Error processing "Instant Download": ${error.message}`);
    return null;
  }
}

// Function to try Resume Cloud method
async function tryResumeCloud($) {
  // Look for both "Resume Cloud" and "Cloud Resume Download" buttons
  const resumeCloudButton = $('a:contains("Resume Cloud"), a:contains("Cloud Resume Download")');
  
  if (resumeCloudButton.length === 0) {
    return null;
  }

  const resumeLink = resumeCloudButton.attr('href');
  if (!resumeLink) {
    return null;
  }

  // Check if it's already a direct download link (workers.dev)
  if (resumeLink.includes('workers.dev') || resumeLink.startsWith('http')) {
    let directLink = resumeLink;
    // Fix spaces in workers.dev URLs by encoding them properly
    if (directLink.includes('workers.dev')) {
      const urlParts = directLink.split('/');
      const filename = urlParts[urlParts.length - 1];
      const encodedFilename = filename.replace(/ /g, '%20');
      urlParts[urlParts.length - 1] = encodedFilename;
      directLink = urlParts.join('/');
    }
    console.log(`[UHDMovies] Found direct "Cloud Resume Download" link: ${directLink}`);
    return directLink;
  }

  // Otherwise, follow the link to get the final download
  try {
    const resumeUrl = new URL(resumeLink, 'https://driveleech.net').href;
    console.log(`[UHDMovies] Found 'Resume Cloud' page link. Following to: ${resumeUrl}`);
    
    // "Click" the link by making another request
    const finalPageResponse = await axiosInstance.get(resumeUrl, { maxRedirects: 10 });
    const $$ = cheerio.load(finalPageResponse.data);

    // Look for direct download links
    let finalDownloadLink = $$('a.btn-success[href*="workers.dev"], a[href*="driveleech.net/d/"]').attr('href');

    if (finalDownloadLink) {
      // Fix spaces in workers.dev URLs by encoding them properly
      if (finalDownloadLink.includes('workers.dev')) {
        // Split the URL at the last slash to separate the base URL from the filename
        const urlParts = finalDownloadLink.split('/');
        const filename = urlParts[urlParts.length - 1];
        // Encode spaces in the filename part only
        const encodedFilename = filename.replace(/ /g, '%20');
        urlParts[urlParts.length - 1] = encodedFilename;
        finalDownloadLink = urlParts.join('/');
      }
      console.log(`[UHDMovies] Extracted final Resume Cloud link: ${finalDownloadLink}`);
      return finalDownloadLink;
    } else {
      console.log('[UHDMovies] Could not find the final download link on the "Resume Cloud" page.');
      return null;
    }
  } catch (error) {
    console.log(`[UHDMovies] Error processing "Resume Cloud": ${error.message}`);
    return null;
  }
}

// Function to follow redirect links and get the final download URL with size info
async function getFinalLink(redirectUrl) {
  try {
    console.log(`[UHDMovies] Following redirect: ${redirectUrl}`);
    
    // Request the driveleech page
    let response = await axiosInstance.get(redirectUrl, { maxRedirects: 10 });
    let $ = cheerio.load(response.data);

    // --- Check for JavaScript redirect ---
    const scriptContent = $('script').html();
    const redirectMatch = scriptContent && scriptContent.match(/window\.location\.replace\("([^"]+)"\)/);

    if (redirectMatch && redirectMatch[1]) {
        const newPath = redirectMatch[1];
        const newUrl = new URL(newPath, 'https://driveleech.net/').href;
        console.log(`[UHDMovies] Found JavaScript redirect. Following to: ${newUrl}`);
        response = await axiosInstance.get(newUrl, { maxRedirects: 10 });
        $ = cheerio.load(response.data);
    }

    // Extract size information from the page
    let sizeInfo = 'Unknown';
    const sizeElement = $('li:contains("Size")').text();
    if (sizeElement) {
      const sizeMatch = sizeElement.match(/Size\s*:\s*([0-9.,]+\s*[KMGT]B)/);
      if (sizeMatch) {
        sizeInfo = sizeMatch[1];
      }
    }

    // Try Resume Cloud first
    let finalUrl = await tryResumeCloud($);
    if (finalUrl) return { url: finalUrl, size: sizeInfo };
    
    // Fallback to Instant Download
    console.log('[UHDMovies] "Resume Cloud" failed, trying "Instant Download" fallback.');
    finalUrl = await tryInstantDownload($);
    if (finalUrl) return { url: finalUrl, size: sizeInfo };

    console.log('[UHDMovies] Both "Resume Cloud" and "Instant Download" methods failed.');
    return null;

  } catch (error) {
    console.error(`[UHDMovies] Error in getFinalLink: ${error.message}`);
    return null;
  }
}

// Compare media to find matching result
function compareMedia(mediaInfo, searchResult) {
  const normalizeString = (str) => String(str || '').toLowerCase().replace(/[^a-zA-Z0-9]/g, '');
  
  const titleWithAnd = mediaInfo.title.replace(/\s*&\s*/g, ' and ');
  const normalizedMediaTitle = normalizeString(titleWithAnd);
  const normalizedResultTitle = normalizeString(searchResult.title);
  
  // Check if titles match or result title contains media title
  if (!normalizedResultTitle.includes(normalizedMediaTitle)) {
    return false;
  }
  
  // Check year if both are available
  if (mediaInfo.year && searchResult.title) {
    const yearInTitle = searchResult.title.match(/\((\d{4})\)/);
    if (yearInTitle) {
      const resultYear = parseInt(yearInTitle[1]);
      if (Math.abs(resultYear - mediaInfo.year) > 1) { // Allow 1 year difference
        return false;
      }
    }
  }
  
  return true;
}

// Function to parse size string into MB
function parseSize(sizeString) {
  if (!sizeString || typeof sizeString !== 'string') {
    return 0;
  }

  const upperCaseSizeString = sizeString.toUpperCase();
  
  // Regex to find a number (integer or float) followed by GB, MB, or KB
  const match = upperCaseSizeString.match(/([0-9.,]+)\s*(GB|MB|KB)/);

  if (!match) {
    return 0;
  }

  const sizeValue = parseFloat(match[1].replace(/,/g, ''));
  if (isNaN(sizeValue)) {
    return 0;
  }
  
  const unit = match[2];

  if (unit === 'GB') {
    return sizeValue * 1024;
  } else if (unit === 'MB') {
    return sizeValue;
  } else if (unit === 'KB') {
    return sizeValue / 1024;
  }
  
  return 0;
}

// New function to resolve the tech.unblockedgames.world links
async function resolveSidToDriveleech(sidUrl) {
  console.log(`[UHDMovies] Resolving SID link: ${sidUrl}`);
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
      await fs.writeFile(`sid_error_page_${Date.now()}.html`, responseStep2.data);
      console.error("  [SID] Wrote final page HTML to file for debugging.");
      return null;
    }
    
    const finalUrl = new URL(finalLinkPath, 'https://tech.unblockedgames.world').href;
    console.log(`  [SID] Dynamic link found: ${finalUrl}`);
    console.log(`  [SID] Dynamic cookie found: ${cookieName}`);

    // Step 5: Set cookie and make final request
    console.log("  [SID] Step 5: Setting cookie and making final request...");
    await jar.setCookie(`${cookieName}=${cookieValue}`, 'https://tech.unblockedgames.world');
    
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
      await fs.writeFile(`sid_error_response_${Date.now()}.html`, error.response.data);
      console.error("  [SID] Wrote error response HTML to file for debugging.");
    }
    return null;
  }
}

// Main function to get streams for TMDB content
async function getUHDMoviesStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  console.log(`[UHDMovies] Attempting to fetch streams for TMDB ID: ${tmdbId}, Type: ${mediaType}${mediaType === 'tv' ? `, S:${season}E:${episode}` : ''}`);
  
  const cacheKey = `uhd_${tmdbId}_${mediaType}${season ? `_s${season}e${episode}` : ''}`;

  try {
    // 1. Check cache first
    let cachedLinks = await getFromCache(cacheKey);
    if (cachedLinks) {
        console.log(`[UHDMovies] Cache HIT for ${cacheKey}. Using ${cachedLinks.length} cached Driveleech links.`);
    } else {
        console.log(`[UHDMovies] Cache MISS for ${cacheKey}. Fetching from source.`);
        // 2. If cache miss, get TMDB info to perform search
        const tmdbUrl = `https://api.themoviedb.org/3/${mediaType === 'tv' ? 'tv' : 'movie'}/${tmdbId}?api_key=${TMDB_API_KEY_UHDMOVIES}`;
        const tmdbResponse = await axios.get(tmdbUrl);
        const tmdbData = tmdbResponse.data;
        const mediaInfo = {
            title: mediaType === 'tv' ? tmdbData.name : tmdbData.title,
            year: parseInt(((mediaType === 'tv' ? tmdbData.first_air_date : tmdbData.release_date) || '').split('-')[0], 10)
        };

        if (!mediaInfo.title) throw new Error('Could not extract title from TMDB response.');
        console.log(`[UHDMovies] TMDB Info: "${mediaInfo.title}" (${mediaInfo.year || 'N/A'})`);

        // 3. Search for the media on UHDMovies
        const searchTitle = mediaInfo.title.replace(/\\s*&\\s*/g, ' and ');
        const searchResults = await searchMovies(searchTitle);
        if (searchResults.length === 0) {
            console.log(`[UHDMovies] No search results found for "${mediaInfo.title}".`);
            await saveToCache(cacheKey, []); // Cache empty result to prevent re-scraping
            return [];
        }

        // 4. Find the best matching result
        const matchingResult = searchResults.find(result => compareMedia(mediaInfo, result));
        if (!matchingResult) {
            console.log(`[UHDMovies] No matching content found for "${mediaInfo.title}" (${mediaInfo.year}).`);
            await saveToCache(cacheKey, []);
            return [];
        }
        console.log(`[UHDMovies] Found matching content: "${matchingResult.title}"`);

        // 5. Extract SID links from the movie/show page
        const downloadInfo = await (mediaType === 'tv' ? extractTvShowDownloadLinks(matchingResult.link, season, episode) : extractDownloadLinks(matchingResult.link));
        if (downloadInfo.links.length === 0) {
            console.log('[UHDMovies] No download links found on page.');
            await saveToCache(cacheKey, []);
            return [];
        }

        // 6. Resolve all SID links to Driveleech links in parallel
        console.log(`[UHDMovies] Resolving ${downloadInfo.links.length} SID link(s)...`);
        const resolutionPromises = downloadInfo.links.map(async (linkInfo) => {
            if (linkInfo.link && linkInfo.link.includes('tech.unblockedgames.world')) {
                const driveleechUrl = await resolveSidToDriveleech(linkInfo.link);
                if (driveleechUrl) {
                    // Return all necessary info for the final step and for caching
                    return { ...linkInfo, driveleechUrl };
                }
            }
            return null;
        });
        
        cachedLinks = (await Promise.all(resolutionPromises)).filter(Boolean);
        
        // 7. Save the successfully resolved Driveleech links to the cache
        if (cachedLinks.length > 0) {
            console.log(`[UHDMovies] Caching ${cachedLinks.length} resolved Driveleech links for key: ${cacheKey}`);
            await saveToCache(cacheKey, cachedLinks);
        } else {
            console.log(`[UHDMovies] No Driveleech links could be resolved. Caching empty result.`);
            await saveToCache(cacheKey, []);
            return [];
        }
    }

    if (!cachedLinks || cachedLinks.length === 0) {
        console.log('[UHDMovies] No Driveleech links found after scraping/cache check.');
        return [];
    }

    // 8. Process all Driveleech links (from cache or fresh) to get final download URLs
    console.log(`[UHDMovies] Processing ${cachedLinks.length} Driveleech link(s) to get final download URLs.`);
    const streamPromises = cachedLinks.map(async (linkInfo) => {
        try {
            const finalLinkData = await getFinalLink(linkInfo.driveleechUrl);

            if (finalLinkData && finalLinkData.url) {
                const rawQuality = linkInfo.rawQuality || '';
                const codecs = extractCodecs(rawQuality);
                return {
                    name: `UHDMovies`,
                    title: `${linkInfo.quality || 'Unknown'}\\n${finalLinkData.size || linkInfo.size || 'Unknown'}`,
                    url: finalLinkData.url,
                    quality: linkInfo.quality,
                    size: finalLinkData.size || linkInfo.size,
                    fullTitle: rawQuality,
                    codecs: codecs,
                    behaviorHints: { bingeGroup: `uhdmovies-${linkInfo.quality}` }
                };
            } else {
                console.warn(`[UHDMovies] Failed to get final link for: ${linkInfo.driveleechUrl}`);
                return null;
            }
        } catch (error) {
            console.error(`[UHDMovies] Error processing driveleech link ${linkInfo.driveleechUrl}: ${error.message}`);
            return null;
        }
    });

    const streams = (await Promise.all(streamPromises)).filter(Boolean);
    console.log(`[UHDMovies] Successfully processed ${streams.length} final stream links.`);
    
    // Sort final streams by size
    streams.sort((a, b) => {
        const sizeA = parseSize(a.size);
        const sizeB = parseSize(b.size);
        return sizeB - sizeA;
    });

    return streams;
  } catch (error) {
    console.error(`[UHDMovies] A critical error occurred in getUHDMoviesStreams for ${tmdbId}: ${error.message}`);
    if (error.stack) console.error(error.stack);
    return [];
  }
}

module.exports = { getUHDMoviesStreams }; 