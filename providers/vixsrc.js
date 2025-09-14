/**
 * Vixsrc streaming provider integration for Stremio
 * React Native compatible version - Standalone (no external dependencies)
 * Converted to Promise-based syntax for sandbox compatibility
 */

// Constants
const TMDB_API_KEY = "68e094699525b18a70bab2f86b1fa706";
const BASE_URL = 'https://vixsrc.to';

// Helper function to make HTTP requests with default headers
function makeRequest(url, options = {}) {
    const defaultHeaders = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json,*/*',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        ...options.headers
    };

    return fetch(url, {
        method: options.method || 'GET',
        headers: defaultHeaders,
        ...options
    })
    .then(response => {
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return response;
    })
    .catch(error => {
        console.error(`[Vixsrc] Request failed for ${url}: ${error.message}`);
        throw error;
    });
}

// Helper function to get TMDB info
function getTmdbInfo(tmdbId, mediaType) {
    const url = `https://api.themoviedb.org/3/${mediaType === 'tv' ? 'tv' : 'movie'}/${tmdbId}?api_key=${TMDB_API_KEY}`;
    
    return makeRequest(url)
    .then(response => response.json())
    .then(data => {
        const title = mediaType === 'tv' ? data.name : data.title;
        const year = mediaType === 'tv' ? data.first_air_date?.substring(0, 4) : data.release_date?.substring(0, 4);
        
        if (!title) {
            throw new Error('Could not extract title from TMDB response');
        }
        
        console.log(`[Vixsrc] TMDB Info: "${title}" (${year})`);
        return { title, year, data };
    });
}

// Helper function to parse M3U8 playlist
function parseM3U8Playlist(content, baseUrl) {
    const streams = [];
    const audioTracks = [];
    const lines = content.split('\n');

    let currentStream = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Parse video streams
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
            // Parse stream info
            const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
            const resolutionMatch = line.match(/RESOLUTION=(\d+x\d+)/);
            const nameMatch = line.match(/NAME="([^"]+)"/) || line.match(/NAME=([^,]+)/);

            if (bandwidthMatch) {
                currentStream = {
                    bandwidth: parseInt(bandwidthMatch[1]),
                    resolution: resolutionMatch ? resolutionMatch[1] : 'Unknown',
                    quality: nameMatch ? nameMatch[1] : getQualityFromResolution(resolutionMatch ? resolutionMatch[1] : 'Unknown'),
                    url: ''
                };
            }
        } 
        // Parse audio tracks
        else if (line.startsWith('#EXT-X-MEDIA:')) {
            const typeMatch = line.match(/TYPE=([^,]+)/);
            const nameMatch = line.match(/NAME="([^"]+)"/);
            const groupIdMatch = line.match(/GROUP-ID="([^"]+)"/);
            const languageMatch = line.match(/LANGUAGE="([^"]+)"/);
            const uriMatch = line.match(/URI="([^"]+)"/);

            if (typeMatch && typeMatch[1] === 'AUDIO') {
                const audioTrack = {
                    type: 'audio',
                    name: nameMatch ? nameMatch[1] : 'Unknown Audio',
                    groupId: groupIdMatch ? groupIdMatch[1] : 'unknown',
                    language: languageMatch ? languageMatch[1] : 'unknown',
                    url: uriMatch ? resolveUrl(uriMatch[1], baseUrl) : null
                };
                audioTracks.push(audioTrack);
            }
        }
        // Handle URLs for video streams
        else if (line.startsWith('http') && currentStream) {
            // This is the URL for the current video stream
            currentStream.url = line.startsWith('http') ? line : resolveUrl(line, baseUrl);
            streams.push(currentStream);
            currentStream = null;
        }
    }

    console.log(`[Vixsrc] Found ${audioTracks.length} audio tracks:`);
    audioTracks.forEach((track, index) => {
        console.log(`   ${index + 1}. ${track.name} (${track.language}) - ${track.url ? 'Available' : 'No URL'}`);
    });

    return { streams, audioTracks };
}

// Helper function to get quality from resolution
function getQualityFromResolution(resolution) {
    if (resolution.includes('1920x1080') || resolution.includes('1080')) {
        return '1080p';
    } else if (resolution.includes('1280x720') || resolution.includes('720')) {
        return '720p';
    } else if (resolution.includes('854x480') || resolution.includes('640x480') || resolution.includes('480')) {
        return '480p';
    } else if (resolution.includes('640x360') || resolution.includes('360')) {
        return '360p';
    } else {
        return resolution;
    }
}

// Helper function to resolve URLs
function resolveUrl(url, baseUrl) {
    if (url.startsWith('http')) {
        return url;
    }

    // Handle relative URLs
    const baseUrlObj = new URL(baseUrl);
    if (url.startsWith('/')) {
        return `${baseUrlObj.protocol}//${baseUrlObj.host}${url}`;
    } else {
        const basePath = baseUrlObj.pathname.substring(0, baseUrlObj.pathname.lastIndexOf('/') + 1);
        return `${baseUrlObj.protocol}//${baseUrlObj.host}${basePath}${url}`;
    }
}

// Helper function to extract stream URL from Vixsrc page
function extractStreamFromPage(url, contentType, contentId, seasonNum, episodeNum) {
    let vixsrcUrl;
    let subtitleApiUrl;

    if (contentType === 'movie') {
        vixsrcUrl = `${BASE_URL}/movie/${contentId}`;
        subtitleApiUrl = `https://sub.wyzie.ru/search?id=${contentId}`;
    } else {
        vixsrcUrl = `${BASE_URL}/tv/${contentId}/${seasonNum}/${episodeNum}`;
        subtitleApiUrl = `https://sub.wyzie.ru/search?id=${contentId}&season=${seasonNum}&episode=${episodeNum}`;
    }

    console.log(`[Vixsrc] Fetching: ${vixsrcUrl}`);

    return makeRequest(vixsrcUrl, {
        headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
    })
    .then(response => response.text())
    .then(html => {
        console.log(`[Vixsrc] HTML length: ${html.length} characters`);

        let masterPlaylistUrl = null;

        // Method 1: Look for window.masterPlaylist (primary method)
        if (html.includes('window.masterPlaylist')) {
            console.log('[Vixsrc] Found window.masterPlaylist');

            const urlMatch = html.match(/url:\s*['"]([^'"]+)['"]/);
            const tokenMatch = html.match(/['"]?token['"]?\s*:\s*['"]([^'"]+)['"]/);
            const expiresMatch = html.match(/['"]?expires['"]?\s*:\s*['"]([^'"]+)['"]/);

            if (urlMatch && tokenMatch && expiresMatch) {
                const baseUrl = urlMatch[1];
                const token = tokenMatch[1];
                const expires = expiresMatch[1];

                console.log('[Vixsrc] Extracted tokens:');
                console.log(`  - Base URL: ${baseUrl}`);
                console.log(`  - Token: ${token.substring(0, 20)}...`);
                console.log(`  - Expires: ${expires}`);

                // Construct the master playlist URL
                if (baseUrl.includes('?b=1')) {
                    masterPlaylistUrl = `${baseUrl}&token=${token}&expires=${expires}&h=1&lang=en`;
                } else {
                    masterPlaylistUrl = `${baseUrl}?token=${token}&expires=${expires}&h=1&lang=en`;
                }

                console.log(`[Vixsrc] Constructed master playlist URL: ${masterPlaylistUrl}`);
            }
        }

        // Method 2: Look for direct .m3u8 URLs
        if (!masterPlaylistUrl) {
            const m3u8Match = html.match(/(https?:\/\/[^'"\s]+\.m3u8[^'"\s]*)/);
            if (m3u8Match) {
                masterPlaylistUrl = m3u8Match[1];
                console.log('[Vixsrc] Found direct .m3u8 URL:', masterPlaylistUrl);
            }
        }

        // Method 3: Look for stream URLs in script tags
        if (!masterPlaylistUrl) {
            const scriptMatches = html.match(/<script[^>]*>(.*?)<\/script>/gs);
            if (scriptMatches) {
                for (const script of scriptMatches) {
                    const streamMatch = script.match(/['"]?(https?:\/\/[^'"\s]+(?:\.m3u8|playlist)[^'"\s]*)/);
                    if (streamMatch) {
                        masterPlaylistUrl = streamMatch[1];
                        console.log('[Vixsrc] Found stream in script:', masterPlaylistUrl);
                        break;
                    }
                }
            }
        }

        if (!masterPlaylistUrl) {
            console.log('[Vixsrc] No master playlist URL found');
            return null;
        }

        return { masterPlaylistUrl, subtitleApiUrl };
    });
}

// Helper function to get subtitles
function getSubtitles(subtitleApiUrl) {
    return makeRequest(subtitleApiUrl)
    .then(response => response.json())
    .then(subtitleData => {
        // Find English subtitle track (same logic as original)
        let subtitleTrack = subtitleData.find(track =>
            track.display.includes('English') && (track.encoding === 'ASCII' || track.encoding === 'UTF-8')
        );

        if (!subtitleTrack) {
            subtitleTrack = subtitleData.find(track => track.display.includes('English') && track.encoding === 'CP1252');
        }

        if (!subtitleTrack) {
            subtitleTrack = subtitleData.find(track => track.display.includes('English') && track.encoding === 'CP1250');
        }

        if (!subtitleTrack) {
            subtitleTrack = subtitleData.find(track => track.display.includes('English') && track.encoding === 'CP850');
        }

        const subtitles = subtitleTrack ? subtitleTrack.url : '';
        console.log(subtitles ? `[Vixsrc] Found subtitles: ${subtitles}` : '[Vixsrc] No English subtitles found');
        return subtitles;
    })
    .catch(error => {
        console.log('[Vixsrc] Subtitle fetch failed:', error.message);
        return '';
    });
}

// Main function to get streams - adapted for Nuvio provider format
function getVixsrcStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    console.log(`[Vixsrc] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);
    
    return getTmdbInfo(tmdbId, mediaType)
    .then(tmdbInfo => {
        const { title, year } = tmdbInfo;
        
        // Extract stream from Vixsrc page
        return extractStreamFromPage(null, mediaType, tmdbId, seasonNum, episodeNum);
    })
    .then(streamData => {
        if (!streamData) {
            console.log('[Vixsrc] No stream data found');
            return [];
        }

        const { masterPlaylistUrl, subtitleApiUrl } = streamData;

        // Return single master playlist with Auto quality
        console.log('[Vixsrc] Returning master playlist with Auto quality...');
        
        // Get subtitles
        return getSubtitles(subtitleApiUrl)
        .then(subtitles => {
            // Return single stream with master playlist
            const nuvioStreams = [{
                name: "Vixsrc",
                title: "Auto Quality Stream",
                url: masterPlaylistUrl,
                quality: 'Auto',
                type: 'direct',
                headers: {
                    'Referer': BASE_URL,
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
                }
            }];

            console.log('[Vixsrc] Successfully processed 1 stream with Auto quality');
            return nuvioStreams;
        });
    })
    .catch(error => {
        console.error(`[Vixsrc] Error in getVixsrcStreams: ${error.message}`);
        return [];
    });
}

module.exports = { getVixsrcStreams };
