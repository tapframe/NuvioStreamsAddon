const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { searchMovies, extractDownloadLinks, resolveLeechproLink, resolveSidToDriveleech, resolveDriveleechLink } = require('../scrapersdirect/topmovies_scraper.js');

const TMDB_API_KEY = process.env.TMDB_API_KEY || "439c478a771f35c05022f9feabcca01c"; // Fallback to a public key

// --- Caching Configuration ---
const CACHE_ENABLED = process.env.DISABLE_CACHE !== 'true';
const CACHE_DIR = path.join(__dirname, '.cache', 'topmovies');
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

// --- Caching Helper Functions ---
const ensureCacheDir = async () => {
    if (!CACHE_ENABLED) return;
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') console.error(`[TopMovies Cache] Error creating cache directory: ${error.message}`);
    }
};

const getFromCache = async (key) => {
    if (!CACHE_ENABLED) return null;
    const cacheFile = path.join(CACHE_DIR, `${key}.json`);
    try {
        const data = await fs.readFile(cacheFile, 'utf-8');
        const cached = JSON.parse(data);
        if (Date.now() > cached.expiry) {
            console.log(`[TopMovies Cache] EXPIRED for key: ${key}`);
            await fs.unlink(cacheFile).catch(() => {});
            return null;
        }
        console.log(`[TopMovies Cache] HIT for key: ${key}`);
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
        console.log(`[TopMovies Cache] SAVED for key: ${key}`);
    } catch (error) {
        console.error(`[TopMovies Cache] WRITE ERROR for key ${key}: ${error.message}`);
    }
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
    const cacheKey = `topmovies_${tmdbId}`;
    
    // 1. Check cache for intermediate links
    let cachedLinks = await getFromCache(cacheKey);
    if (cachedLinks) {
        console.log(`[TopMovies Cache] Using ${cachedLinks.length} cached driveleech links.`);
    } else {
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

        // 4. Resolve to driveleech links
        const resolutionPromises = filteredLinks.map(async (qualityLink) => {
            const techLink = await resolveLeechproLink(qualityLink.url);
            if (!techLink) return null;
            const driveleechUrl = await resolveSidToDriveleech(techLink);
            if(driveleechUrl) {
                return { ...qualityLink, driveleechUrl };
            }
            return null;
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

    // 6. Always fetch final stream URLs fresh from cached driveleech links
    const streamPromises = cachedLinks.map(async (cachedLink) => {
      try {
        console.log(`[TopMovies] Processing cached link: ${cachedLink.quality}`);
        
        const finalData = await resolveDriveleechLink(cachedLink.driveleechUrl);
        if (!finalData || !finalData.url) return null;

        const cleanQualityMatch = (cachedLink.quality || '').match(/(\\d{3,4}p|4K)/i);
        const cleanQuality = cleanQualityMatch ? cleanQualityMatch[0] : (cachedLink.quality || 'UNK');
        
        return {
          name: `TopMovies - ${cleanQuality}`,
          title: `${finalData.title || "Unknown Title"}\n${finalData.size || 'Unknown Size'}`,
          url: finalData.url,
          quality: cachedLink.quality, // Keep original for internal use if needed
          size: finalData.size,
          behaviorHints: {
            bingeGroup: `topmovies-${cleanQuality}`
          }
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