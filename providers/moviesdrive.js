/**
 * MoviesDrive streaming provider integration for Stremio
 */

const { findStreamingLinks } = require('../scrapersdirect/moviesdrive-extractor.js');
const axios = require('axios');

// Helper function to convert callback-based function to Promise
function promisifyFindStreamingLinks(query) {
    return new Promise((resolve, reject) => {
        try {
            findStreamingLinks(query, (links) => {
                resolve(links);
            });
        } catch (error) {
            reject(error);
        }
    });
}

// Helper function to get movie/show metadata from TMDB
async function getTMDBMetadata(tmdbId, mediaType) {
    try {
        const tmdbApiKey = process.env.TMDB_API_KEY;
        if (!tmdbApiKey) {
            console.warn('[MoviesDrive] TMDB API key not found, using TMDB ID only');
            return null;
        }

        const url = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${tmdbApiKey}`;
        const response = await axios.get(url, { timeout: 10000 });
        return response.data;
    } catch (error) {
        console.error(`[MoviesDrive] Error fetching TMDB metadata:`, error.message);
        return null;
    }
}

// Helper function to construct search query
function constructSearchQuery(metadata, mediaType, season = null, episode = null) {
    if (!metadata) {
        return null;
    }

    let title = metadata.title || metadata.name;
    let year = '';
    
    if (metadata.release_date) {
        year = new Date(metadata.release_date).getFullYear();
    } else if (metadata.first_air_date) {
        year = new Date(metadata.first_air_date).getFullYear();
    }

    let query = title;
    if (year) {
        query += ` ${year}`;
    }

    // For TV shows, add season and episode info if provided
    if (mediaType === 'tv' && season !== null && episode !== null) {
        const seasonStr = season.toString().padStart(2, '0');
        const episodeStr = episode.toString().padStart(2, '0');
        query += ` S${seasonStr}E${episodeStr}`;
    }

    return query;
}

// Helper function to convert MoviesDrive links to Stremio format
function convertToStremioFormat(links, mediaType) {
    return links.map(link => {
        // Extract quality from various sources
        let quality = 'Unknown';
        if (link.quality && link.quality !== 'Unknown') {
            quality = link.quality;
        } else if (link.fileName) {
            const qualityMatch = link.fileName.match(/(\d{3,4})[pP]/);
            if (qualityMatch) {
                quality = qualityMatch[1] + 'p';
            }
        }

        // Create name with source and quality info (without size)
        let name = `MoviesDrive`;
        if (link.source && link.source !== 'Unknown') {
            name += ` (${link.source})`;
        }
        if (quality !== 'Unknown') {
            name += ` - ${quality}`;
        }

        // Create title with current details and filename
        let title = link.title || 'MoviesDrive Stream';
        if (link.size && link.size !== 'Unknown') {
            title += `\n${link.size}`;
        }
        if (link.fileName) {
            title += `\n${link.fileName}`;
        }

        return {
            name: name,
            title: title,
            url: link.url,
            quality: quality,
            size: link.size || undefined,
            source: 'MoviesDrive',
            fileName: link.fileName || undefined
        };
    });
}

// Main function to get streams from MoviesDrive
async function getMoviesDriveStreams(tmdbId, mediaType, season = null, episode = null) {
    try {
        console.log(`[MoviesDrive] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);
        
        // Get metadata from TMDB to construct search query
        const metadata = await getTMDBMetadata(tmdbId, mediaType);
        if (!metadata) {
            console.log(`[MoviesDrive] Could not fetch metadata for TMDB ID: ${tmdbId}`);
            return [];
        }

        // Construct search query
        const searchQuery = constructSearchQuery(metadata, mediaType, season, episode);
        if (!searchQuery) {
            console.log(`[MoviesDrive] Could not construct search query`);
            return [];
        }

        console.log(`[MoviesDrive] Searching for: "${searchQuery}"`);

        // Search for streaming links
        const links = await promisifyFindStreamingLinks(searchQuery);
        
        if (!links || links.length === 0) {
            console.log(`[MoviesDrive] No streams found for query: "${searchQuery}"`);
            return [];
        }

        console.log(`[MoviesDrive] Found ${links.length} streaming links`);

        // Convert to Stremio format
        const stremioStreams = convertToStremioFormat(links, mediaType);
        
        return stremioStreams;
    } catch (error) {
        console.error(`[MoviesDrive] Error fetching streams:`, error.message);
        return [];
    }
}

module.exports = { getMoviesDriveStreams };