const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const path = require('path');
const readline = require('readline');

// Import provider functions
const { getTopMoviesStreams } = require('./providers/topmovies');
const { getUHDMoviesStreams } = require('./providers/uhdmovies');
const { getMoviesModStreams } = require('./providers/moviesmod');
const { getDramaDripStreams } = require('./providers/dramadrip');

const TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";

// Create readline interface for user input
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Helper function to get TMDB details
async function getTMDBDetails(tmdbId) {
    try {
        const response = await axios.get(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_API_KEY}`);
        return {
            type: 'movie',
            title: response.data.title,
            year: new Date(response.data.release_date).getFullYear(),
            imdbId: response.data.imdb_id
        };
    } catch (error) {
        // Try TV series if movie fails
        try {
            const response = await axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}`);
            return {
                type: 'tv',
                title: response.data.name,
                year: new Date(response.data.first_air_date).getFullYear(),
                imdbId: response.data.external_ids?.imdb_id
            };
        } catch (tvError) {
            throw new Error(`Failed to fetch TMDB details for ID ${tmdbId}`);
        }
    }
}

// Helper function to prompt user input
function prompt(question) {
    return new Promise((resolve) => {
        rl.question(question, resolve);
    });
}

// Main cache population function
async function populateCache(tmdbId, mediaType, seasonNum = null, episodeNum = null) {
    console.log(`\n🔄 Starting cache population for TMDB ID: ${tmdbId}`);
    
    try {
        // Get TMDB details
        const tmdbDetails = await getTMDBDetails(tmdbId);
        console.log(`📺 Found: ${tmdbDetails.title} (${tmdbDetails.year}) - ${tmdbDetails.type}`);
        
        const providers = [
            { name: 'TopMovies', func: getTopMoviesStreams },
            { name: 'UHDMovies', func: getUHDMoviesStreams },
            { name: 'MoviesMod', func: getMoviesModStreams },
            { name: 'DramaDrip', func: getDramaDripStreams }
        ];
        
        for (const provider of providers) {
            console.log(`\n🔍 Processing ${provider.name}...`);
            try {
                let streams;
                
                // Handle different provider parameter signatures
                if (provider.name === 'AnimePahe') {
                    streams = await provider.func(
                        parseInt(tmdbId),
                        tmdbDetails.title,
                        mediaType || tmdbDetails.type,
                        seasonNum,
                        episodeNum
                    );
                } else if (provider.name === 'Xprime') {
                    streams = await provider.func(
                        tmdbDetails.title,
                        tmdbDetails.year,
                        mediaType || tmdbDetails.type,
                        seasonNum,
                        episodeNum
                    );
                } else {
                    // Standard signature for most providers
                    streams = await provider.func(
                        parseInt(tmdbId),
                        mediaType || tmdbDetails.type,
                        seasonNum,
                        episodeNum
                    );
                }
                
                if (streams && streams.length > 0) {
                    console.log(`✅ ${provider.name}: Cached ${streams.length} streams`);
                    streams.forEach(stream => {
                        console.log(`   - ${stream.name} (${stream.quality || 'Unknown quality'})`);
                    });
                } else {
                    console.log(`❌ ${provider.name}: No streams found`);
                }
            } catch (error) {
                console.log(`❌ ${provider.name}: Error - ${error.message}`);
            }
        }
        
        console.log(`\n✅ Cache population completed for TMDB ID: ${tmdbId}`);
        
    } catch (error) {
        console.error(`❌ Error processing TMDB ID ${tmdbId}: ${error.message}`);
    }
}

// Interactive mode
async function interactiveMode() {
    console.log('🎬 Provider Cache Populator');
    console.log('============================');
    console.log('This script will populate the cache for all providers using TMDB IDs.');
    console.log('Press Ctrl+C to exit at any time.\n');
    
    while (true) {
        try {
            const tmdbId = await prompt('Enter TMDB ID: ');
            
            if (!tmdbId || tmdbId.trim() === '') {
                console.log('❌ Please enter a valid TMDB ID');
                continue;
            }
            
            // Check if it's a TV series
            const mediaType = await prompt('Media type (movie/tv) [auto-detect]: ');
            let seasonNum = null;
            let episodeNum = null;
            
            if (mediaType.toLowerCase() === 'tv' || mediaType.toLowerCase() === 'series') {
                const season = await prompt('Season number [1]: ');
                const episode = await prompt('Episode number [1]: ');
                seasonNum = parseInt(season) || 1;
                episodeNum = parseInt(episode) || 1;
            }
            
            await populateCache(tmdbId.trim(), mediaType.trim() || null, seasonNum, episodeNum);
            
            const continueChoice = await prompt('\nPopulate another? (y/n) [y]: ');
            if (continueChoice.toLowerCase() === 'n' || continueChoice.toLowerCase() === 'no') {
                break;
            }
            
        } catch (error) {
            console.error(`❌ Error: ${error.message}`);
        }
    }
    
    console.log('\n👋 Goodbye!');
    rl.close();
}

// Batch mode from command line arguments
async function batchMode() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log('Usage: node cache_populator.js <tmdbId1> [tmdbId2] [tmdbId3] ...');
        console.log('   or: node cache_populator.js (for interactive mode)');
        return;
    }
    
    console.log(`🎬 Batch processing ${args.length} TMDB IDs...\n`);
    
    for (const tmdbId of args) {
        await populateCache(tmdbId.trim());
        console.log('\n' + '='.repeat(50));
    }
    
    console.log('\n✅ Batch processing completed!');
}

// Main execution
async function main() {
    try {
        // Check if command line arguments are provided
        if (process.argv.length > 2) {
            await batchMode();
        } else {
            await interactiveMode();
        }
    } catch (error) {
        console.error('❌ Fatal error:', error.message);
        process.exit(1);
    }
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
    console.log('\n\n👋 Goodbye!');
    rl.close();
    process.exit(0);
});

// Run the script
if (require.main === module) {
    main();
}

module.exports = {
    populateCache,
    getTMDBDetails
};