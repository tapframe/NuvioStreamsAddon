const axios = require('axios');

// Function to parse command line arguments
const parseArgs = () => {
    const args = process.argv.slice(2);
    const options = {};
    let i = 0;
    while (i < args.length) {
        const arg = args[i];
        if (arg.startsWith('--')) {
            const key = arg.substring(2);
            if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
                options[key] = args[i + 1];
                i++;
            } else {
                options[key] = true; // Flag argument
            }
        } else {
            // Positional arguments, if any (none expected for this script based on current design)
        }
        i++;
    }
    return options;
};

const getVidZeeStreams = async (tmdbId, mediaType, seasonNum, episodeNum) => {
    if (!tmdbId) {
        console.error('[VidZee] Error: TMDB ID (tmdbId) is required.');
        return [];
    }

    if (!mediaType || (mediaType !== 'movie' && mediaType !== 'tv')) {
        console.error('[VidZee] Error: mediaType is required and must be either "movie" or "tv".');
        return [];
    }

    if (mediaType === 'tv') {
        if (!seasonNum) {
            console.error('[VidZee] Error: Season (seasonNum) is required for TV shows.');
            return [];
        }
        if (!episodeNum) {
            console.error('[VidZee] Error: Episode (episodeNum) is required for TV shows.');
            return [];
        }
    }

    const servers = [3, 4, 5];

    const streamPromises = servers.map(async (sr) => {
        let targetApiUrl = `https://player.vidzee.wtf/api/server?id=${tmdbId}&sr=${sr}`;

        if (mediaType === 'tv') {
            targetApiUrl += `&ss=${seasonNum}&ep=${episodeNum}`;
        }

        let finalApiUrl;
        let headers = {
            'Referer': 'https://core.vidzee.wtf/' // Default for proxy method
        };
        let timeout = 7000; // Reduced timeout

        const proxyBaseUrl = process.env.VIDZEE_PROXY_URL || process.env.SHOWBOX_PROXY_URL_VALUE;
        if (proxyBaseUrl) {
            finalApiUrl = proxyBaseUrl + encodeURIComponent(targetApiUrl);
        } else {
            finalApiUrl = targetApiUrl;
        }

        console.log(`[VidZee] Fetching from server ${sr}: ${targetApiUrl}`);

        try {
            const response = await axios.get(finalApiUrl, {
                headers: headers,
                timeout: timeout
            });

            const responseData = response.data;

            if (!responseData || typeof responseData !== 'object') {
                console.error(`[VidZee S${sr}] Error: Invalid response data from API.`);
                return [];
            }
            
            if (responseData.tracks) {
                delete responseData.tracks;
            }

            let apiSources = [];
            if (responseData.url && Array.isArray(responseData.url)) {
                apiSources = responseData.url;
            } else if (responseData.link && typeof responseData.link === 'string') {
                apiSources = [responseData];
            }

            if (!apiSources || apiSources.length === 0) {
                console.log(`[VidZee S${sr}] No stream sources found in API response.`);
                return [];
            }

            const streams = apiSources.map(sourceItem => {
                // Prefer sourceItem.name as label, fallback to sourceItem.type, then 'VidZee Stream'
                const label = sourceItem.name || sourceItem.type || 'VidZee';
                // Ensure quality has 'p' if it's a resolution, or keep it as is
                const quality = String(label).match(/^\d+$/) ? `${label}p` : label;
                const language = sourceItem.language || sourceItem.lang;
                
                return {
                    title: `VidZee S${sr} - ${quality}`,
                    url: sourceItem.link, // Use sourceItem.link for the URL
                    quality: quality,
                    language: language,
                    provider: "VidZee",
                    size: "Unknown size",
                    behaviorHints: {
                        notWebReady: true,
                        headers: { 
                            'Referer': 'https://core.vidzee.wtf/'
                        }
                    }
                };
            }).filter(stream => stream.url);

            console.log(`[VidZee S${sr}] Successfully extracted ${streams.length} streams.`);
            return streams;

        } catch (error) {
            if (error.response) {
                console.error(`[VidZee S${sr}] Error fetching: ${error.response.status} ${error.response.statusText}`);
            } else if (error.request) {
                console.error(`[VidZee S${sr}] Error fetching: No response received.`);
            } else {
                console.error(`[VidZee S${sr}] Error fetching:`, error.message);
            }
            return [];
        }
    });

    const allStreamsNested = await Promise.all(streamPromises);
    const allStreams = allStreamsNested.flat();

    console.log(`[VidZee] Found a total of ${allStreams.length} streams from servers ${servers.join(', ')}.`);
    return allStreams;
};

module.exports = { getVidZeeStreams }; 