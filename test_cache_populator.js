#!/usr/bin/env node

/**
 * Test script for the cache populator
 * This script tests the cache populator with a few popular TMDB IDs
 */

const { populateCache, getTMDBDetails } = require('./cache_populator');

// Test TMDB IDs - using popular and recent content more likely to be available
const testIds = [
    { id: '550', name: 'Fight Club (Movie)' },
    { id: '680', name: 'Pulp Fiction (Movie)' },
    { id: '1396', name: 'Breaking Bad (TV Series)', type: 'tv', season: 1, episode: 1 }
];

async function runTests() {
    console.log('🧪 Testing Cache Populator');
    console.log('==========================\n');
    
    for (const test of testIds) {
        console.log(`\n🎬 Testing: ${test.name} (TMDB ID: ${test.id})`);
        console.log('-'.repeat(50));
        
        try {
            // Test TMDB details fetching
            console.log('📋 Fetching TMDB details...');
            const details = await getTMDBDetails(test.id);
            console.log(`✅ Title: ${details.title}`);
            console.log(`✅ Year: ${details.year}`);
            console.log(`✅ Type: ${details.type}`);
            
            // Test cache population
            console.log('\n🔄 Testing cache population...');
            await populateCache(test.id, test.type, test.season, test.episode);
            
            console.log(`✅ Test completed for ${test.name}`);
            
        } catch (error) {
            console.error(`❌ Test failed for ${test.name}: ${error.message}`);
        }
        
        console.log('\n' + '='.repeat(60));
    }
    
    console.log('\n🎉 All tests completed!');
    console.log('\n💡 Tips:');
    console.log('   - Check the .cache folders in each provider directory');
    console.log('   - Look for files with "final_v1" in their names');
    console.log('   - Run the actual addon to verify cached data works');
}

// Handle errors gracefully
process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled error:', error.message);
    process.exit(1);
});

// Run tests if this file is executed directly
if (require.main === module) {
    runTests().catch(error => {
        console.error('❌ Test suite failed:', error.message);
        process.exit(1);
    });
}

module.exports = { runTests };