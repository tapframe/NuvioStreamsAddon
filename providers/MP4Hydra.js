const axios = require('axios');
const FormData = require('form-data');

// Helper function to generate slug from title
function generateSlug(title) {
    return title.toLowerCase()
        .replace(/[^\w\s-]/g, '') // Remove special characters
        .replace(/\s+/g, '-')     // Replace spaces with hyphens
        .replace(/-+/g, '-');     // Replace multiple hyphens with a single hyphen
}

// Process episode data from MP4Hydra response
function processEpisode(episode, baseServer, serverName, serverNumber) {
    const videoUrl = `${baseServer}${episode.src}`;
    const subtitles = episode.subs ? episode.subs.map(sub => ({
        label: sub.label,
        url: `${baseServer}${sub.src}`
    })) : [];
    
    return {
        title: episode.show_title || episode.title,
        episode: episode.title,
        type: episode.type,
        quality: episode.quality || episode.label,
        videoUrl: videoUrl,
        server: serverName,
        serverNumber: serverNumber,
        subtitles: subtitles
    };
}

// Main function to get streams from MP4Hydra
async function getMP4HydraStreams(tmdbId, mediaType, seasonNum = null, episodeNum = null) {
    try {
        console.log(`[MP4Hydra] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}, Season: ${seasonNum}, Episode: ${episodeNum}`);
        
        // Get TMDB details
        const details = await getTMDBDetails(tmdbId, mediaType);
        if (!details) {
            console.log(`[MP4Hydra] Could not fetch details for TMDB ID: ${tmdbId}`);
            return [];
        }
        
        console.log(`[MP4Hydra] Found title: ${details.title} (${details.year})`);
        
        // Generate slug in the format "movie-name-year"
        let slug = details.slug;
        if (mediaType === 'movie' && details.year) {
            slug = `${details.slug}-${details.year}`;
        }
        console.log(`[MP4Hydra] Using slug: ${slug}`);
        
        // Create form data for multipart/form-data request
        const formData = new FormData();
        formData.append('v', '8');
        formData.append('z', JSON.stringify([{
            s: slug,
            t: mediaType,
            se: seasonNum,
            ep: episodeNum
        }]));
        
        // Make request to MP4Hydra API
        const response = await axios({
            method: 'post',
            url: 'https://mp4hydra.org/info2?v=8',
            data: formData,
            headers: {
                ...formData.getHeaders(),
                'User-Agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
                'Origin': 'https://mp4hydra.org',
                'Referer': `https://mp4hydra.org/${mediaType}/${slug}`,
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'same-origin'
            },
            timeout: 10000
        });
        
        // Process response
        if (response.data && response.data.playlist && response.data.playlist.length > 0) {
            const playlist = response.data.playlist;
            const servers = response.data.servers;
            
            console.log(`[MP4Hydra] Found ${playlist.length} videos`);
            console.log(`[MP4Hydra] Available servers: ${Object.keys(servers).join(', ')}`);
            
            // For TV shows, find the specific episode
            if (mediaType === 'tv' && seasonNum && episodeNum) {
                const paddedSeason = seasonNum.toString().padStart(2, '0');
                const paddedEpisode = episodeNum.toString().padStart(2, '0');
                const seasonEpisode = `S${paddedSeason}E${paddedEpisode}`;
                
                const targetEpisode = playlist.find(item => 
                    item.title && item.title.toUpperCase() === seasonEpisode.toUpperCase()
                );
                
                if (!targetEpisode) {
                    console.log(`[MP4Hydra] Could not find ${seasonEpisode}`);
                    return [];
                }
                
                console.log(`[MP4Hydra] Found episode: ${targetEpisode.show_title || targetEpisode.title}`);
                
                // Process streams from main servers
                const streams = [];
                const serverConfig = [
                    { name: 'Beta', number: '#1' },
                    { name: 'Beta#3', number: '#2' }
                ];
                
                serverConfig.forEach(server => {
                    const serverName = server.name;
                    const serverNumber = server.number;
                    
                    if (servers[serverName]) {
                        const baseServer = servers[serverName];
                        console.log(`[MP4Hydra] Processing server: ${serverName} (${baseServer})`);
                        
                        const processedEpisode = processEpisode(targetEpisode, baseServer, serverName, serverNumber);
                        
                        // Convert to standard stream format
                        streams.push({
                            title: `${details.title} - ${seasonEpisode} - ${processedEpisode.quality} [MP4Hydra ${serverNumber}]`,
                            url: processedEpisode.videoUrl,
                            quality: processedEpisode.quality,
                            provider: "MP4Hydra",
                            size: "Unknown size",
                            behaviorHints: {
                                notWebReady: true,
                                headers: { 
                                    'Referer': 'https://mp4hydra.org/'
                                }
                            }
                        });
                        
                        // Add subtitle tracks if available
                        if (processedEpisode.subtitles && processedEpisode.subtitles.length > 0) {
                            streams[streams.length - 1].subtitles = processedEpisode.subtitles.map(sub => ({
                                url: sub.url,
                                lang: sub.label
                            }));
                        }
                    }
                });
                
                return streams;
            }
            
            // For movies, process all videos
            const streams = [];
            const serverConfig = [
                { name: 'Beta', number: '#1' },
                { name: 'Beta#3', number: '#2' }
            ];
            
            serverConfig.forEach(server => {
                const serverName = server.name;
                const serverNumber = server.number;
                
                if (servers[serverName]) {
                    const baseServer = servers[serverName];
                    console.log(`[MP4Hydra] Processing server: ${serverName} (${baseServer})`);
                    
                    playlist.forEach(item => {
                        const processedItem = processEpisode(item, baseServer, serverName, serverNumber);
                        
                        // Convert to standard stream format
                        streams.push({
                            title: `${details.title} - ${processedItem.quality} [MP4Hydra ${serverNumber}]`,
                            url: processedItem.videoUrl,
                            quality: processedItem.quality,
                            provider: "MP4Hydra",
                            size: "Unknown size",
                            behaviorHints: {
                                notWebReady: true,
                                headers: { 
                                    'Referer': 'https://mp4hydra.org/'
                                }
                            }
                        });
                        
                        // Add subtitle tracks if available
                        if (processedItem.subtitles && processedItem.subtitles.length > 0) {
                            streams[streams.length - 1].subtitles = processedItem.subtitles.map(sub => ({
                                url: sub.url,
                                lang: sub.label
                            }));
                        }
                    });
                }
            });
            
            return streams;
        } else {
            // Try with original title if the first attempt failed
            if (details.title !== details.original_title) {
                return await tryAlternativeTitle(details, mediaType, seasonNum, episodeNum);
            }
            
            // Try without year for movies
            if (mediaType === 'movie' && details.year) {
                return await tryWithoutYear(details, mediaType, seasonNum, episodeNum);
            }
            
            console.log('[MP4Hydra] No streaming links found');
            return [];
        }
    } catch (error) {
        console.error(`[MP4Hydra] Error fetching streams:`, error.message);
        return [];
    }
}

// Helper function to try with original title
async function tryAlternativeTitle(details, mediaType, seasonNum, episodeNum) {
    try {
        console.log(`[MP4Hydra] Retrying with original title: ${details.original_title}`);
        const originalSlug = generateSlug(details.original_title);
        let originalFullSlug = originalSlug;
        
        if (mediaType === 'movie' && details.year) {
            originalFullSlug = `${originalSlug}-${details.year}`;
        }
        
        // Create new form data with original title
        const formData = new FormData();
        formData.append('v', '8');
        formData.append('z', JSON.stringify([{
            s: originalFullSlug,
            t: mediaType,
            se: seasonNum,
            ep: episodeNum
        }]));
        
        const response = await axios({
            method: 'post',
            url: 'https://mp4hydra.org/info2?v=8',
            data: formData,
            headers: {
                ...formData.getHeaders(),
                'User-Agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
                'Origin': 'https://mp4hydra.org',
                'Referer': `https://mp4hydra.org/${mediaType}/${originalFullSlug}`,
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'same-origin'
            },
            timeout: 10000
        });
        
        // Process response
        if (response.data && response.data.playlist && response.data.playlist.length > 0) {
            const playlist = response.data.playlist;
            const servers = response.data.servers;
            
            console.log(`[MP4Hydra] Found ${playlist.length} videos with original title`);
            
            // For TV shows, find the specific episode
            if (mediaType === 'tv' && seasonNum && episodeNum) {
                const paddedSeason = seasonNum.toString().padStart(2, '0');
                const paddedEpisode = episodeNum.toString().padStart(2, '0');
                const seasonEpisode = `S${paddedSeason}E${paddedEpisode}`;
                
                const targetEpisode = playlist.find(item => 
                    item.title && item.title.toUpperCase() === seasonEpisode.toUpperCase()
                );
                
                if (!targetEpisode) {
                    console.log(`[MP4Hydra] Could not find ${seasonEpisode} with original title`);
                    return [];
                }
                
                // Process streams from main servers
                const streams = [];
                const serverConfig = [
                    { name: 'Beta', number: '#1' },
                    { name: 'Beta#3', number: '#2' }
                ];
                
                serverConfig.forEach(server => {
                    const serverName = server.name;
                    const serverNumber = server.number;
                    
                    if (servers[serverName]) {
                        const baseServer = servers[serverName];
                        console.log(`[MP4Hydra] Processing server: ${serverName} (${baseServer})`);
                        
                        const processedEpisode = processEpisode(targetEpisode, baseServer, serverName, serverNumber);
                        
                        // Convert to standard stream format
                        streams.push({
                            title: `${details.original_title} - ${seasonEpisode} - ${processedEpisode.quality} [MP4Hydra ${serverNumber}]`,
                            url: processedEpisode.videoUrl,
                            quality: processedEpisode.quality,
                            provider: "MP4Hydra",
                            size: "Unknown size",
                            behaviorHints: {
                                notWebReady: true,
                                headers: { 
                                    'Referer': 'https://mp4hydra.org/'
                                }
                            }
                        });
                        
                        // Add subtitle tracks if available
                        if (processedEpisode.subtitles && processedEpisode.subtitles.length > 0) {
                            streams[streams.length - 1].subtitles = processedEpisode.subtitles.map(sub => ({
                                url: sub.url,
                                lang: sub.label
                            }));
                        }
                    }
                });
                
                return streams;
            }
            
            // For movies, process all videos
            const streams = [];
            const serverConfig = [
                { name: 'Beta', number: '#1' },
                { name: 'Beta#3', number: '#2' }
            ];
            
            serverConfig.forEach(server => {
                const serverName = server.name;
                const serverNumber = server.number;
                
                if (servers[serverName]) {
                    const baseServer = servers[serverName];
                    console.log(`[MP4Hydra] Processing server: ${serverName} (${baseServer})`);
                    
                    playlist.forEach(item => {
                        const processedItem = processEpisode(item, baseServer, serverName, serverNumber);
                        
                        // Convert to standard stream format
                        streams.push({
                            title: `${details.original_title} - ${processedItem.quality} [MP4Hydra ${serverNumber}]`,
                            url: processedItem.videoUrl,
                            quality: processedItem.quality,
                            provider: "MP4Hydra",
                            size: "Unknown size",
                            behaviorHints: {
                                notWebReady: true,
                                headers: { 
                                    'Referer': 'https://mp4hydra.org/'
                                }
                            }
                        });
                        
                        // Add subtitle tracks if available
                        if (processedItem.subtitles && processedItem.subtitles.length > 0) {
                            streams[streams.length - 1].subtitles = processedItem.subtitles.map(sub => ({
                                url: sub.url,
                                lang: sub.label
                            }));
                        }
                    });
                }
            });
            
            return streams;
        }
        
        return [];
    } catch (error) {
        console.error(`[MP4Hydra] Error with alternative title:`, error.message);
        return [];
    }
}

// Helper function to try without year
async function tryWithoutYear(details, mediaType, seasonNum, episodeNum) {
    try {
        console.log(`[MP4Hydra] Retrying with title only (without year): ${details.title}`);
        const titleOnlySlug = details.slug;
        
        // Create new form data with title only
        const formData = new FormData();
        formData.append('v', '8');
        formData.append('z', JSON.stringify([{
            s: titleOnlySlug,
            t: mediaType,
            se: seasonNum,
            ep: episodeNum
        }]));
        
        const response = await axios({
            method: 'post',
            url: 'https://mp4hydra.org/info2?v=8',
            data: formData,
            headers: {
                ...formData.getHeaders(),
                'User-Agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
                'Origin': 'https://mp4hydra.org',
                'Referer': `https://mp4hydra.org/${mediaType}/${titleOnlySlug}`,
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'same-origin'
            },
            timeout: 10000
        });
        
        // Process response
        if (response.data && response.data.playlist && response.data.playlist.length > 0) {
            const playlist = response.data.playlist;
            const servers = response.data.servers;
            
            console.log(`[MP4Hydra] Found ${playlist.length} videos with title only`);
            
            // For movies, process all videos
            const streams = [];
            const serverConfig = [
                { name: 'Beta', number: '#1' },
                { name: 'Beta#3', number: '#2' }
            ];
            
            serverConfig.forEach(server => {
                const serverName = server.name;
                const serverNumber = server.number;
                
                if (servers[serverName]) {
                    const baseServer = servers[serverName];
                    console.log(`[MP4Hydra] Processing server: ${serverName} (${baseServer})`);
                    
                    playlist.forEach(item => {
                        const processedItem = processEpisode(item, baseServer, serverName, serverNumber);
                        
                        // Convert to standard stream format
                        streams.push({
                            title: `${details.title} - ${processedItem.quality} [MP4Hydra ${serverNumber}]`,
                            url: processedItem.videoUrl,
                            quality: processedItem.quality,
                            provider: "MP4Hydra",
                            size: "Unknown size",
                            behaviorHints: {
                                notWebReady: true,
                                headers: { 
                                    'Referer': 'https://mp4hydra.org/'
                                }
                            }
                        });
                        
                        // Add subtitle tracks if available
                        if (processedItem.subtitles && processedItem.subtitles.length > 0) {
                            streams[streams.length - 1].subtitles = processedItem.subtitles.map(sub => ({
                                url: sub.url,
                                lang: sub.label
                            }));
                        }
                    });
                }
            });
            
            return streams;
        }
        
        return [];
    } catch (error) {
        console.error(`[MP4Hydra] Error with title-only:`, error.message);
        return [];
    }
}

// Helper function to get TMDB details
async function getTMDBDetails(tmdbId, mediaType) {
    const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
    
    try {
        console.log(`[MP4Hydra] Fetching ${mediaType} details for TMDB ID: ${tmdbId}`);
        const response = await axios.get(`https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${TMDB_API_KEY}`);
        
        if (mediaType === 'movie') {
            return {
                title: response.data.title,
                original_title: response.data.original_title,
                year: response.data.release_date ? response.data.release_date.split('-')[0] : null,
                slug: generateSlug(response.data.title)
            };
        } else {
            return {
                title: response.data.name,
                original_title: response.data.original_name,
                year: response.data.first_air_date ? response.data.first_air_date.split('-')[0] : null,
                slug: generateSlug(response.data.name)
            };
        }
    } catch (error) {
        console.error(`[MP4Hydra] Error fetching details from TMDB:`, error.message);
        return null;
    }
}

module.exports = { getMP4HydraStreams }; 