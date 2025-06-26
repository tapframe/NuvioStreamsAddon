const axios = require('axios');
const cheerio = require('cheerio');
const { URLSearchParams, URL } = require('url');
const FormData = require('form-data');

// Constants
const BASE_URL = 'https://uhdmovies.email';
const TMDB_API_KEY_UHDMOVIES = "439c478a771f35c05022f9feabcca01c"; // Public TMDB API key

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
const CACHE_TTL = 60 * 60 * 1000; // 1 hour TTL for cache entries

// Function to get from cache
function getFromCache(type, key) {
  if (uhdMoviesCache[type] && uhdMoviesCache[type][key]) {
    const entry = uhdMoviesCache[type][key];
    if (Date.now() - entry.timestamp < CACHE_TTL) {
      console.log(`[UHDMovies Cache] HIT for ${type} - ${key}`);
      return entry.data;
    }
    console.log(`[UHDMovies Cache] STALE for ${type} - ${key}`);
    delete uhdMoviesCache[type][key]; // Remove stale entry
  }
  console.log(`[UHDMovies Cache] MISS for ${type} - ${key}`);
  return null;
}

// Function to save to cache
function saveToCache(type, key, data) {
  if (!uhdMoviesCache[type]) uhdMoviesCache[type] = {};
  uhdMoviesCache[type][key] = {
    data: data,
    timestamp: Date.now()
  };
  console.log(`[UHDMovies Cache] SAVED for ${type} - ${key}`);
}

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
  
  // Extract codec/format
  if (text.includes('hevc') || text.includes('x265')) {
    quality.push('HEVC');
  } else if (text.includes('x264')) {
    quality.push('x264');
  }
  
  // Extract special features
  if (text.includes('hdr')) {
    quality.push('HDR');
  }
  if (text.includes('dolby vision') || text.includes('dovi') || /\bdv\b/.test(text)) {
    quality.push('DV');
  }
  if (text.includes('10bit')) {
    quality.push('10-bit');
  }
  if (text.includes('imax')) {
    quality.push('IMAX');
  }
  if (text.includes('bluray') || text.includes('blu-ray')) {
    quality.push('BluRay');
  }
  
  // Extract audio info
  if (text.includes('dual audio') || (text.includes('hindi') && text.includes('english'))) {
    quality.push('Dual Audio');
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
            if (currentElement.is('p') && currentElement.find('a[href*="driveleech.net"]').length > 0) {
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
    
    // Find all download links and their associated quality information
    $('a[href*="driveleech.net"]').each((index, element) => {
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
          link: link
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

// Main function to get streams for TMDB content
async function getUHDMoviesStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  console.log(`[UHDMovies] Attempting to fetch streams for TMDB ID: ${tmdbId}, Type: ${mediaType}${mediaType === 'tv' ? `, S:${season}E:${episode}` : ''}`);
  
  try {
    // Get media info from TMDB
    const isTvShow = mediaType === 'tv';
    const tmdbUrl = `https://api.themoviedb.org/3/${isTvShow ? 'tv' : 'movie'}/${tmdbId}?api_key=${TMDB_API_KEY_UHDMOVIES}`;
    console.log(`[UHDMovies] Fetching TMDB info from: ${tmdbUrl}`);
    
    const tmdbResponse = await axios.get(tmdbUrl);
    if (!tmdbResponse.data || tmdbResponse.data.success === false) {
      throw new Error(`TMDB API error: ${tmdbResponse.data?.status_message || 'Unknown TMDB error'}`);
    }
    
    const tmdbData = tmdbResponse.data;
    const mediaInfo = {
      title: isTvShow ? tmdbData.name : tmdbData.title,
      year: parseInt(((isTvShow ? tmdbData.first_air_date : tmdbData.release_date) || '').split('-')[0], 10)
    };
    
    if (!mediaInfo.title) {
      console.error('[UHDMovies] Failed to get title from TMDB data:', tmdbData);
      throw new Error('Could not extract title from TMDB response.');
    }
    
    console.log(`[UHDMovies] TMDB Info: "${mediaInfo.title}" (${mediaInfo.year || 'N/A'})`);
    
    // Check cache first
    const cacheType = isTvShow ? 'show' : 'movie';
    const searchCacheKey = isTvShow 
      ? `${mediaInfo.title.toLowerCase()}_${mediaInfo.year}_s${season}e${episode}`
      : `${mediaInfo.title.toLowerCase()}_${mediaInfo.year}`;
      
    let cachedResult = getFromCache(cacheType, searchCacheKey);
    
    if (cachedResult) {
      console.log(`[UHDMovies] Using cached result for "${mediaInfo.title}".`);
      return cachedResult;
    }
    
    // Search for the media
    const searchTitle = mediaInfo.title.replace(/\s*&\s*/g, ' and ');
    if (searchTitle !== mediaInfo.title) {
      console.log(`[UHDMovies] Modified search title from "${mediaInfo.title}" to "${searchTitle}"`);
    }
    const searchResults = await searchMovies(searchTitle);
    
    if (searchResults.length === 0) {
      console.log(`[UHDMovies] No search results found for "${mediaInfo.title}".`);
      saveToCache(cacheType, searchCacheKey, []);
      return [];
    }
    
    // Find all matching results
    const matchingResults = searchResults.filter(result => compareMedia(mediaInfo, result));
    
    if (matchingResults.length === 0) {
      console.log(`[UHDMovies] No matching content found for "${mediaInfo.title}" (${mediaInfo.year || 'N/A'}).`);
      saveToCache(cacheType, searchCacheKey, []);
      return [];
    }
    
    console.log(`[UHDMovies] Found ${matchingResults.length} matching results. Trying each one...`);

    for (const matchingResult of matchingResults) {
        console.log(`[UHDMovies] Found matching content: "${matchingResult.title}" at ${matchingResult.link}`);
        
        // Extract download links from the page
        const downloadInfo = await (isTvShow ? extractTvShowDownloadLinks(matchingResult.link, season, episode) : extractDownloadLinks(matchingResult.link));
        
        if (downloadInfo.links.length === 0) {
          console.log('[UHDMovies] No download links found on this page, trying next result.');
          continue;
        }
        
        console.log(`[UHDMovies] Processing ${downloadInfo.links.length} download links...`);
        
        // Process all links to get final URLs
        const streamPromises = downloadInfo.links.map(async (link) => {
          try {
            const finalLink = await getFinalLink(link.link);
            if (finalLink) {
              const streamTitle = isTvShow
                ? `UHDMovies - S${season}E${episode} - ${link.quality}`
                : `UHDMovies - ${link.quality}`;
    
              return {
                title: streamTitle,
                url: finalLink.url,
                quality: link.quality,
                size: finalLink.size !== 'Unknown' ? finalLink.size : link.size,
                provider: 'UHDMovies',
                languages: ['English'], // UHDMovies primarily has English content
                subtitles: [],
                codecs: [] // Could be enhanced to parse codecs from quality string
              };
            }
            return null;
          } catch (error) {
            console.error(`[UHDMovies] Error processing link: ${error.message}`);
            return null;
          }
        });
        
        const streams = (await Promise.all(streamPromises)).filter(stream => stream !== null);
        
        if (streams.length > 0) {
            console.log(`[UHDMovies] Successfully extracted ${streams.length} streams.`);
            // Sort streams by size in descending order
            streams.sort((a, b) => {
              const sizeA = parseSize(a.size);
              const sizeB = parseSize(b.size);
              return sizeB - sizeA;
            });
            
            // Cache the result
            saveToCache(cacheType, searchCacheKey, streams);
            return streams;
        }
    }
    
    console.log(`[UHDMovies] All matching results processed, but no valid streams found.`);
    saveToCache(cacheType, searchCacheKey, []);
    return [];
    
  } catch (error) {
    console.error(`[UHDMovies] Error fetching streams: ${error.message}`);
    return [];
  }
}

module.exports = { getUHDMoviesStreams }; 