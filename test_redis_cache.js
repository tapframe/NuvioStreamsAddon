#!/usr/bin/env node

/**
 * Redis Cache Test Script
 * Tests the Redis cache functionality for NuvioStreams providers
 */

require('dotenv').config();
const RedisCache = require('./utils/redisCache');

async function testRedisCache() {
    console.log('🧪 Testing Redis Cache Functionality\n');
    
    // Test 1: Basic Redis Cache Operations
    console.log('📝 Test 1: Basic Redis Cache Operations');
    const testCache = new RedisCache('TestProvider');
    
    try {
        // Wait a moment for Redis connection
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const testKey = 'test_key_' + Date.now();
        const testData = {
            message: 'Hello Redis!',
            timestamp: Date.now(),
            data: ['item1', 'item2', 'item3']
        };
        
        console.log(`   ✅ Saving test data to Redis with key: ${testKey}`);
        await testCache.saveToCache(testKey, testData, 'test_subdir');
        
        console.log(`   🔍 Retrieving test data from Redis...`);
        const retrievedData = await testCache.getFromCache(testKey, 'test_subdir');
        
        if (retrievedData && JSON.stringify(retrievedData) === JSON.stringify(testData)) {
            console.log('   ✅ Redis cache test PASSED - Data matches!');
        } else {
            console.log('   ❌ Redis cache test FAILED - Data mismatch');
            console.log('   Expected:', testData);
            console.log('   Retrieved:', retrievedData);
        }
        
    } catch (error) {
        console.log(`   ❌ Redis cache test FAILED: ${error.message}`);
    }
    
    // Test 2: Provider Integration Test
    console.log('\n📝 Test 2: Provider Integration Test');
    
    try {
        // Test MoviesMod provider cache
        const { getMoviesModStreams } = require('./providers/moviesmod');
        console.log('   ✅ MoviesMod provider loaded successfully');
        
        // Test UHDMovies provider cache
        const { getUHDMoviesStreams } = require('./providers/uhdmovies');
        console.log('   ✅ UHDMovies provider loaded successfully');
        
        console.log('   ✅ All providers with Redis cache loaded successfully!');
        
    } catch (error) {
        console.log(`   ❌ Provider integration test FAILED: ${error.message}`);
    }
    
    // Test 3: Redis Connection Status
    console.log('\n📝 Test 3: Redis Connection Status');
    
    try {
        if (testCache.redisClient && testCache.redisClient.status === 'ready') {
            console.log('   ✅ Redis client is connected and ready');
            
            // Test Redis ping
            const pingResult = await testCache.redisClient.ping();
            if (pingResult === 'PONG') {
                console.log('   ✅ Redis ping successful');
            } else {
                console.log('   ❌ Redis ping failed');
            }
            
        } else {
            console.log('   ❌ Redis client is not ready');
            console.log(`   Status: ${testCache.redisClient ? testCache.redisClient.status : 'null'}`);
        }
        
    } catch (error) {
        console.log(`   ❌ Redis connection test FAILED: ${error.message}`);
    }
    
    // Test 4: Environment Configuration
    console.log('\n📝 Test 4: Environment Configuration');
    
    console.log(`   USE_REDIS_CACHE: ${process.env.USE_REDIS_CACHE}`);
    console.log(`   REDIS_URL: ${process.env.REDIS_URL ? 'Set' : 'Not set'}`);
    console.log(`   DISABLE_CACHE: ${process.env.DISABLE_CACHE}`);
    
    if (process.env.USE_REDIS_CACHE === 'true' && process.env.REDIS_URL) {
        console.log('   ✅ Redis configuration is correct');
    } else {
        console.log('   ❌ Redis configuration is incomplete');
    }
    
    // Cleanup
    console.log('\n🧹 Cleaning up...');
    testCache.cleanup();
    
    console.log('\n🎉 Redis cache test completed!');
}

// Run the test
if (require.main === module) {
    testRedisCache().catch(console.error);
}

module.exports = { testRedisCache };