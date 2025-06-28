const axios = require('axios');
const { getUHDMoviesStreams } = require('./uhdmovies'); // Re-use the TMDB and caching logic if possible
const { searchMovies, extractDownloadLinks, resolveLeechproLink, resolveSidToDriveleech, resolveDriveleechLink } = require('../scrapersdirect/topmovies_scraper.js');

const TMDB_API_KEY = process.env.TMDB_API_KEY || "439c478a771f35c05022f9feabcca01c"; // Fallback to a public key

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
    // 1. Get TMDB info to perform search
    const tmdbUrl = `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_API_KEY}`;
    const tmdbResponse = await axios.get(tmdbUrl);
    const mediaInfo = {
      title: tmdbResponse.data.title,
      year: parseInt((tmdbResponse.data.release_date || '').split('-')[0], 10)
    };
    
    console.log(`[TopMovies] TMDB Info: "${mediaInfo.title}" (${mediaInfo.year})`);

    // 2. Search for the media on TopMovies
    const searchResults = await searchMovies(mediaInfo.title);
    if (searchResults.length === 0) {
      console.log(`[TopMovies] No search results for "${mediaInfo.title}".`);
      return [];
    }

    // 3. Find the best matching result
    const matchingResult = searchResults.find(result => compareMedia(mediaInfo, result));
    if (!matchingResult) {
      console.log(`[TopMovies] No matching content found for "${mediaInfo.title}" (${mediaInfo.year}).`);
      return [];
    }

    console.log(`[TopMovies] Found matching content: "${matchingResult.title}"`);

    // 4. Extract quality/download pages from the movie page
    const downloadInfo = await extractDownloadLinks(matchingResult.url);
    if (!downloadInfo || downloadInfo.links.length === 0) {
      console.log('[TopMovies] No download links found on page.');
      return [];
    }

    // 5. Process all download links in parallel
    const streamPromises = downloadInfo.links.map(async (qualityLink) => {
      try {
        console.log(`[TopMovies] Processing quality: ${qualityLink.quality}`);
        
        // Step 1: Resolve leechpro.blog link
        const techLink = await resolveLeechproLink(qualityLink.url);
        if (!techLink) return null;

        // Step 2: Bypass tech.unblockedgames.world
        const driveleechUrl = await resolveSidToDriveleech(techLink);
        if (!driveleechUrl) return null;

        // Step 3: Resolve driveleech to get final link, size, and accurate title
        const finalData = await resolveDriveleechLink(driveleechUrl);
        if (!finalData || !finalData.url) return null;

        // Construct the stream object
        const cleanQualityMatch = (qualityLink.quality || '').match(/(\\d{3,4}p|4K)/i);
        const cleanQuality = cleanQualityMatch ? cleanQualityMatch[0] : (qualityLink.quality || 'UNK');
        
        return {
          name: `TopMovies - ${cleanQuality}`,
          title: `${finalData.title || matchingResult.title}\n${finalData.size || 'Unknown Size'}`,
          url: finalData.url,
          quality: qualityLink.quality, // Keep original for internal use if needed
          size: finalData.size,
          behaviorHints: {
            bingeGroup: `topmovies-${cleanQuality}`
          }
        };
      } catch (error) {
        console.error(`[TopMovies] Error processing quality link ${qualityLink.url}: ${error.message}`);
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