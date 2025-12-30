#!/usr/bin/env node

const express = require('express');
// const { serveHTTP } = require('stremio-addon-sdk'); // serveHTTP is not directly used with Express in this setup
const addonInterface = require('./addon');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto'); // For generating a simple hash for personalized manifest ID
const axios = require('axios'); // Added axios for HTTP requests
const { AsyncLocalStorage } = require('async_hooks');
// body-parser is not strictly needed if we remove the POST /api/set-cookie endpoint and don't have other JSON POST bodies to parse for now.
// const bodyParser = require('body-parser'); 

const app = express();

// AsyncLocalStorage for per-request context isolation
// This ensures cookies don't leak between concurrent requests
const requestContext = new AsyncLocalStorage();

// Helper to get current request config (safe for concurrent requests)
function getRequestConfig() {
    const store = requestContext.getStore();
    return store?.config || {};
}

// Export for use in addon.js
global.getRequestConfig = getRequestConfig;
global.requestContext = requestContext;

// REMOVE: User cookies directory and related fs operations
// const USER_COOKIES_DIR = path.join(__dirname, '.user_cookies');
// (async () => { ... })();

// Enable CORS for all routes
app.use(cors());

app.use(express.json()); // Middleware to parse JSON bodies, needed for /api/validate-cookie

// REMOVE: bodyParser.json() if no other routes need it.
// app.use(bodyParser.json());

// Serve static files from the 'views' directory (for the landing page)
app.use(express.static(path.join(__dirname, 'views')));

// Serve static files from the 'static' directory (for videos, images, etc.)
app.use('/static', express.static(path.join(__dirname, 'static')));

// Configure route - handles both direct access and path-based parametrized access
app.get('*configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// Middleware to extract user-supplied cookie, region, and providers from request query
// and make them available in a request-scoped context (isolated per request)
app.use((req, res, next) => {
    // Extract from query parameters (legacy format)
    const userSuppliedCookie = req.query.cookie;
    const userRegionPreference = req.query.region;
    const userProvidersQuery = req.query.providers;
    const userMinQualitiesQuery = req.query.min_qualities;
    const userCookiesParam = req.query.cookies; // JSON array of ui tokens
    const userScraperApiKey = req.query.scraper_api_key;
    const userExcludeCodecsQuery = req.query.exclude_codecs;

    // Extract from URL path (new format for Android compatibility)
    const pathParams = {};
    if (req.path !== '/manifest.json' && !req.path.endsWith('/manifest.json')) {
        // Split path into segments, ignoring empty strings
        const pathSegments = req.path.split('/').filter(segment => segment);

        // If the last segment is manifest.json, remove it for processing
        if (pathSegments.length > 0 && pathSegments[pathSegments.length - 1] === 'manifest.json') {
            pathSegments.pop();
        }

        // If the segments contain 'stream', we need to extract only the path parameters before it
        const streamIndex = pathSegments.indexOf('stream');
        const paramSegments = streamIndex !== -1 ? pathSegments.slice(0, streamIndex) : pathSegments;

        // Process each path segment as a parameter
        paramSegments.forEach(segment => {
            const paramParts = segment.split('=');
            if (paramParts.length === 2) {
                const [key, value] = paramParts;
                pathParams[key] = value;
            }
        });

        if (Object.keys(pathParams).length > 0) {
            const maskedPathParams = { ...pathParams };
            if (maskedPathParams.cookie) maskedPathParams.cookie = '[MASKED]';
            if (maskedPathParams.cookies) maskedPathParams.cookies = '[MASKED_ARRAY]';
            if (maskedPathParams.scraper_api_key) maskedPathParams.scraper_api_key = '[MASKED]';
            console.log(`[server.js] Extracted path parameters: ${JSON.stringify(maskedPathParams)}`);
        }
    }

    // Build request-specific config (isolated per request)
    const requestConfig = {};

    // Prioritize path parameters over query parameters
    const cookie = pathParams.cookie || userSuppliedCookie;
    const region = pathParams.region || userRegionPreference;
    const providers = pathParams.providers || userProvidersQuery;
    const minQualities = pathParams.min_qualities || userMinQualitiesQuery;
    const cookiesParam = pathParams.cookies || userCookiesParam;
    const scraperApiKey = pathParams.scraper_api_key || userScraperApiKey;
    const excludeCodecs = pathParams.exclude_codecs || userExcludeCodecsQuery;

    if (cookie) {
        try {
            requestConfig.cookie = decodeURIComponent(cookie);
        } catch (e) {
            console.error(`[server.js] Error decoding cookie from request: ${cookie}`, e.message);
        }
    }
    if (region) {
        requestConfig.region = region.toUpperCase();
    }
    if (providers) {
        requestConfig.providers = providers;
    }
    if (minQualities) {
        try {
            const decodedQualities = decodeURIComponent(minQualities);
            requestConfig.minQualities = JSON.parse(decodedQualities);
        } catch (e) {
            console.error(`[server.js] Error parsing min_qualities from request: ${minQualities}`, e.message);
        }
    }
    if (scraperApiKey) {
        try {
            requestConfig.scraper_api_key = decodeURIComponent(scraperApiKey);
        } catch (e) {
            console.error(`[server.js] Error decoding scraper_api_key from request: ${scraperApiKey}`, e.message);
        }
    }
    // Parse multi-cookies param (encoded JSON array)
    if (cookiesParam) {
        try {
            const decodedCookies = decodeURIComponent(cookiesParam);
            const parsed = JSON.parse(decodedCookies);
            if (Array.isArray(parsed)) {
                // Store as array of strings
                requestConfig.cookies = parsed.filter(c => typeof c === 'string' && c.trim().length > 0);
            }
        } catch (e) {
            console.error(`[server.js] Error parsing cookies array from request: ${cookiesParam}`, e.message);
        }
    }
    if (excludeCodecs) {
        try {
            const decodedExcludeCodecs = decodeURIComponent(excludeCodecs);
            requestConfig.excludeCodecs = JSON.parse(decodedExcludeCodecs);
        } catch (e) {
            console.error(`[server.js] Error parsing exclude_codecs from request: ${excludeCodecs}`, e.message);
        }
    }

    if (Object.keys(requestConfig).length > 0) {
        // Mask sensitive information in logs
        const configForLog = { ...requestConfig };
        if (configForLog.cookie) configForLog.cookie = '[PRESENT: ****]';
        if (configForLog.scraper_api_key) configForLog.scraper_api_key = '[PRESENT: ****]';
        if (configForLog.cookies) configForLog.cookies = `[${configForLog.cookies.length} cookies]`;

        console.log(`[server.js] Request config for this request: ${JSON.stringify(configForLog)}`);

        // Debug logging for stream requests (mask sensitive)
        if (req.path.includes('stream') || req.url.includes('stream')) {
            const maskedUrlForLog = (req.url || '').replace(/(cookie=|cookies=|scraper_api_key=)[^&/]+/g, '$1[MASKED]');
            const maskedPathParamsForLog = (() => {
                try {
                    const clone = { ...pathParams };
                    if (clone.cookie) clone.cookie = '[MASKED]';
                    if (clone.cookies) clone.cookies = '[MASKED_ARRAY]';
                    if (clone.scraper_api_key) clone.scraper_api_key = '[MASKED]';
                    return clone;
                } catch (_) { return { masked: true }; }
            })();
            const maskedQueryForLog = (() => {
                try {
                    const clone = { ...req.query };
                    if (clone.cookie) clone.cookie = '[MASKED]';
                    if (clone.cookies) clone.cookies = '[MASKED_ARRAY]';
                    if (clone.scraper_api_key) clone.scraper_api_key = '[MASKED]';
                    return clone;
                } catch (_) { return { masked: true }; }
            })();
            console.log(`[server.js] STREAM REQUEST detected - URL: ${maskedUrlForLog}`);
            console.log(`[server.js] STREAM REQUEST parameters - Path: ${JSON.stringify(maskedPathParamsForLog)}, Query: ${JSON.stringify(maskedQueryForLog)}`);
        }
    }

    // Log the full URL for debugging (mask the cookie value and API key for privacy)
    const fullUrl = req.originalUrl || req.url;
    let maskedUrl = fullUrl.replace(/cookie=([^&/]+)/g, 'cookie=[MASKED]');
    maskedUrl = maskedUrl.replace(/scraper_api_key=([^&/]+)/g, 'scraper_api_key=[MASKED]');

    // Only log for relevant paths to reduce noise
    if (req.path.includes('/manifest.json') || req.path.startsWith('/stream')) {
        console.log(`Incoming request: ${maskedUrl}`);
    }

    // Run the rest of the request within AsyncLocalStorage context for isolation
    // This ensures each request has its own isolated config that won't leak to other requests
    requestContext.run({ config: requestConfig }, () => {
        // Also set on req for direct access in middleware
        req.nuvioConfig = requestConfig;


        global.currentRequestConfig = requestConfig;

        next();
    });
});

// REMOVE: API endpoint for setting a custom cookie (/api/set-cookie)
// app.post('/api/set-cookie', async (req, res) => { ... });

// REMOVE: API endpoint to verify a cookie exists (/api/check-cookie)
// app.get('/api/check-cookie', async (req, res) => { ... });

// New API endpoint to validate FebBox cookie
app.post('/api/validate-cookie', async (req, res) => {
    const { cookie } = req.body;

    if (!cookie || typeof cookie !== 'string' || cookie.trim() === '') {
        return res.status(400).json({ isValid: false, message: 'Cookie is required.' });
    }

    const FEBBOX_TEST_SHARE_URL = 'https://www.febbox.com/share/cbaV67Kp'; // A known public share
    const FEBBOX_PLAYER_URL = 'https://www.febbox.com/file/player';
    const cookieForRequest = cookie.startsWith('ui=') ? cookie : `ui=${cookie}`;
    const tokenForHeader = cookie.startsWith('ui=') ? cookie.slice(3) : cookie; // for ui-token header

    console.log(`[validate-cookie] Testing cookie: ${cookie.substring(0, 15)}...`);

    try {
        // PRIMARY VALIDATION: Use febbox.andresdev.org lightweight API
        // Uses a well-known movie id and expects JSON with `sources` if token is valid
        try {
            const primaryResponse = await axios.get('https://febbox.andresdev.org/movie/950396', {
                headers: {
                    'User-Agent': 'Mozilla/5.0',
                    'Accept': 'application/json',
                    'ui-token': tokenForHeader,
                    // optional extra headers seen in example; not strictly required but harmless
                    'Origin': 'https://pstream.mov',
                    'Referer': 'https://pstream.mov/settings'
                },
                timeout: 12000,
                validateStatus: () => true
            });

            if (primaryResponse.status === 429) {
                console.warn('[validate-cookie] Primary API returned 429 (rate limited).');
                return res.status(429).json({ isValid: false, message: 'Rate limited by validation API' });
            }

            if (primaryResponse.status === 200 && primaryResponse.data && Array.isArray(primaryResponse.data.sources)) {
                const hasSources = primaryResponse.data.sources.length > 0;
                if (hasSources) {
                    console.log('[validate-cookie] PRIMARY SUCCESS: Sources present from febbox.andresdev API.');
                    return res.json({ isValid: true, message: 'Cookie valid (primary API).' });
                }
            }

            console.log(`[validate-cookie] PRIMARY did not confirm validity (status ${primaryResponse.status}). Falling back...`);
        } catch (primaryErr) {
            console.warn(`[validate-cookie] PRIMARY API error, falling back: ${primaryErr.message}`);
            // continue to fallback flow below
        }

        // Step 1: Try to access the public share page
        console.log(`[validate-cookie] Step 1: Accessing ${FEBBOX_TEST_SHARE_URL}`);
        const sharePageResponse = await axios.get(FEBBOX_TEST_SHARE_URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'text/html',
                'Cookie': cookieForRequest
            },
            timeout: 10000,
            maxRedirects: 0,
            validateStatus: () => true // Accept all statuses to analyze them
        });

        if (sharePageResponse.status !== 200 || !sharePageResponse.data || typeof sharePageResponse.data !== 'string') {
            let message = 'Failed to load test share page.';
            if (sharePageResponse.status === 301 || sharePageResponse.status === 302) {
                const location = sharePageResponse.headers.location || '';
                message = location.includes('/login') || location.includes('/passport')
                    ? 'Redirected to login page.'
                    : `Redirected from share page (${location}).`;
            } else {
                message = `Share page access error: Status ${sharePageResponse.status}.`;
            }
            console.log(`[validate-cookie] Step 1 FAILED: ${message}`);
            return res.json({ isValid: false, message });
        }

        const htmlContent = sharePageResponse.data;
        console.log('[validate-cookie] Step 1 SUCCESS: Share page accessed.');

        // Step 2: Extract FID and Share Key from the share page HTML
        let fid = null;
        let shareKey = null;

        const fidMatches = htmlContent.match(/div\s+class="file[^"]*"\s+data-id="(\d+)"/gi);
        if (fidMatches) {
            for (const match of fidMatches) {
                const fidFromMatch = match.match(/data-id="(\d+)"/i);
                if (fidFromMatch && fidFromMatch[1] && fidFromMatch[1] !== '0') {
                    fid = fidFromMatch[1]; // Use the first valid non-zero FID
                    break;
                }
            }
        }

        let shareKeyMatch = htmlContent.match(/var\s+share_key\s*=\s*['"]([a-zA-Z0-9-]+)['"]/);
        if (!shareKeyMatch) shareKeyMatch = htmlContent.match(/share_key:\s*['"]([a-zA-Z0-9-]+)['"]/);
        if (!shareKeyMatch) shareKeyMatch = htmlContent.match(/shareid\s*=\s*['"]([a-zA-Z0-9-]+)['"]/);
        if (shareKeyMatch) {
            shareKey = shareKeyMatch[1];
        } else {
            // Fallback: try to get share_key from the test URL itself
            const urlParts = FEBBOX_TEST_SHARE_URL.split('/');
            const potentialKey = urlParts[urlParts.length - 1];
            if (/^[a-zA-Z0-9-]+$/.test(potentialKey)) shareKey = potentialKey;
        }

        if (!fid || !shareKey) {
            const message = 'Could not extract necessary FID or Share Key from the test page.';
            console.log(`[validate-cookie] Step 2 FAILED: ${message} (FID: ${fid}, ShareKey: ${shareKey})`);
            return res.json({ isValid: false, message });
        }
        console.log(`[validate-cookie] Step 2 SUCCESS: Extracted FID: ${fid}, ShareKey: ${shareKey}`);

        // Step 3: Attempt to fetch player sources with extracted FID and Share Key
        console.log(`[validate-cookie] Step 3: Accessing player with FID ${fid}, ShareKey ${shareKey}`);
        const playerPostData = new URLSearchParams();
        playerPostData.append('fid', fid);
        playerPostData.append('share_key', shareKey);

        const playerResponse = await axios.post(FEBBOX_PLAYER_URL, playerPostData.toString(), {
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': cookieForRequest
            },
            timeout: 15000
        });

        if (playerResponse.data && typeof playerResponse.data === 'string') {
            if (playerResponse.data.includes('sources = [') ||
                (playerResponse.data.includes('http') && (playerResponse.data.includes('.mp4') || playerResponse.data.includes('.m3u8')))) {
                console.log('[validate-cookie] Step 3 SUCCESS: Player sources found. Cookie is VALID.');
                return res.json({ isValid: true, message: 'Cookie successfully fetched video sources.' });
            }
        }

        // If we reach here, player did not return expected sources
        let playerResponseMessage = 'Player did not return valid video sources.';
        if (playerResponse.data && typeof playerResponse.data === 'object') {
            // FebBox often returns JSON like {code: -1, msg: "user not found"}
            playerResponseMessage = playerResponse.data.msg || JSON.stringify(playerResponse.data).substring(0, 100);
        } else if (playerResponse.data && typeof playerResponse.data === 'string') {
            playerResponseMessage = `Player returned: ${playerResponse.data.substring(0, 100)}...`;
        }

        console.log(`[validate-cookie] Step 3 FAILED: ${playerResponseMessage}`);
        return res.json({ isValid: false, message: playerResponseMessage });

    } catch (error) {
        console.error('[validate-cookie] Error during validation process:', error.message);
        let errorMessage = 'Failed to validate cookie.';
        if (error.code === 'ECONNABORTED') {
            errorMessage = 'Validation timed out connecting to FebBox.';
        } else if (error.response) {
            errorMessage = `FebBox server error: ${error.response.status}`;
        }
        return res.status(500).json({ isValid: false, message: errorMessage });
    }
});

// API endpoint to fetch FebBox flow for a cookie (quota/usage)
app.post('/api/febbox-flow', async (req, res) => {
    try {
        const { cookie } = req.body || {};
        if (!cookie || typeof cookie !== 'string') {
            return res.status(400).json({ ok: false, message: 'cookie is required' });
        }
        const headers = {
            'User-Agent': 'Mozilla/5.0',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'Cookie': cookie.startsWith('ui=') ? cookie : `ui=${cookie}`
        };
        const resp = await axios.get('https://www.febbox.com/console/user_cards', {
            headers,
            timeout: 12000,
            validateStatus: () => true
        });
        if (resp.status !== 200 || !resp.data || !resp.data.data || !resp.data.data.flow) {
            return res.status(200).json({ ok: false, message: `Unexpected response (status ${resp.status})` });
        }
        const flow = resp.data.data.flow;
        return res.json({
            ok: true, flow: {
                traffic_limit_mb: flow.traffic_limit_mb,
                traffic_usage_mb: flow.traffic_usage_mb,
                reset_at: flow.reset_at,
                is_vip: flow.is_vip
            }
        });
    } catch (e) {
        return res.status(500).json({ ok: false, message: e.message });
    }
});

// Add middleware to extract cookie and region preference from request queries
app.use((req, res, next) => {
    const userCookie = req.query.cookie;
    const userRegionPreference = req.query.region ? req.query.region.toUpperCase() : null;

    // Set these values as globals for backward compatibility
    global.currentRequestUserCookie = userCookie || null;
    global.currentRequestRegionPreference = userRegionPreference || null;

    // Log the cookie and region preference for debugging
    if (req.path === '/manifest.json' || req.path === '/stream') {
        console.log(`Request to ${req.path}: User cookie provided: ${userCookie ? 'Yes (length: ' + userCookie.length + ')' : 'No'}`);
        console.log(`Request to ${req.path}: Region preference: ${userRegionPreference || 'None'}`);

        // Log the full URL with cookie masked for privacy
        const fullUrl = req.protocol + '://' + req.get('host') + req.originalUrl;
        const maskedUrl = userCookie ?
            fullUrl.replace(userCookie, '***COOKIE-MASKED***') :
            fullUrl;
        console.log(`Full request URL: ${maskedUrl}`);
    }

    // Also extract from stremio-addon-sdk config that might be passed in the request body
    if (req.path === '/stream' && req.body && req.body.config) {
        // If not already set from query params, try to get from config
        if (!global.currentRequestUserCookie && req.body.config.cookie) {
            global.currentRequestUserCookie = req.body.config.cookie;
        }
        if (!global.currentRequestRegionPreference && req.body.config.region) {
            global.currentRequestRegionPreference = req.body.config.region.toUpperCase();
        }

        // Add these directly to the config so addon.js can access them
        req.body.config.cookie = global.currentRequestUserCookie;
        req.body.config.region = global.currentRequestRegionPreference;
    }

    next();
});

// Add middleware to specifically handle path-based parameters in stream URLs
app.use((req, res, next) => {
    // Check if this is a stream request with path-based parameters
    const pathMatch = req.path.match(/^\/(.*?)\/stream\/([^\/]+)\/([^\/]+)\.json$/);

    if (pathMatch) {
        const [, pathParams, type, id] = pathMatch;
        console.log(`[server.js] Detected path-based stream request: ${req.path.replace(/(cookie=|cookies=|scraper_api_key=)[^/&]+/g, '$1[MASKED]')}`);
        // Mask any sensitive values in the composed pathParams string
        const maskedParamsStr = String(pathParams)
            .replace(/(cookie=)[^/&]+/g, '$1[MASKED]')
            .replace(/(cookies=)[^/&]+/g, '$1[MASKED_ARRAY]')
            .replace(/(scraper_api_key=)[^/&]+/g, '$1[MASKED]');
        console.log(`[server.js] Path params: ${maskedParamsStr}, Type: ${type}, ID: ${id}`);

        // Rewrite the URL to the standard format that the SDK expects
        const originalQuery = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
        req.url = `/stream/${type}/${id}.json${originalQuery}`;

        console.log(`[server.js] Rewritten URL: ${req.url}`);
    }

    next();
});

// Serve a customized version of manifest.json - catch path-based format first
app.get('*manifest.json', async (req, res) => {
    try {
        const userCookie = global.currentRequestConfig.cookie;
        const userRegion = global.currentRequestConfig.region;
        const userProviders = global.currentRequestConfig.providers;

        const originalManifest = addonInterface.manifest;
        let personalizedManifest = JSON.parse(JSON.stringify(originalManifest)); // Deep clone

        // Keep the original name from manifest.json
        personalizedManifest.name = originalManifest.name;

        // Ensure the config array exists
        if (!personalizedManifest.config) {
            personalizedManifest.config = [];
        }

        // Flag to check if any personalization was applied for ID/Name generation
        let isPersonalized = false;

        if (userCookie) {
            isPersonalized = true;
            // Add/Update cookie in the manifest config
            const cookieConfigIndex = personalizedManifest.config.findIndex(c => c.key === 'userFebBoxCookie');
            const cookieValueForManifest = userCookie.startsWith('ui=') ? userCookie : `ui=${userCookie}`;
            if (cookieConfigIndex > -1) {
                personalizedManifest.config[cookieConfigIndex].default = cookieValueForManifest;
            } else {
                personalizedManifest.config.push({
                    key: 'userFebBoxCookie',
                    type: 'text',
                    title: 'Your FebBox Cookie (auto-set)',
                    default: cookieValueForManifest,
                    required: false,
                    hidden: true // Hide this from user settings as it's set via URL
                });
            }
            console.log(`[Manifest] Cookie will be part of the config.`);
        }

        if (userRegion) {
            isPersonalized = true;
            // Add/Update region in the manifest config
            const regionConfigIndex = personalizedManifest.config.findIndex(c => c.key === 'userRegionChoice');
            if (regionConfigIndex > -1) {
                personalizedManifest.config[regionConfigIndex].default = userRegion;
            } else {
                personalizedManifest.config.push({
                    key: 'userRegionChoice',
                    type: 'text',
                    title: 'Selected Region (auto-set)',
                    default: userRegion,
                    required: false,
                    hidden: true // Hide this from user settings
                });
            }
            // Only append region to the name if specified
            personalizedManifest.name = `${originalManifest.name} (${userRegion} Region)`;
            personalizedManifest.description = `${originalManifest.description} (Using your ${userRegion} Region for enhanced access.)`;
            personalizedManifest.isRegionPersonalized = true; // Custom flag for UI
            console.log(`[Manifest] Region ${userRegion} applied to name, description, and config.`);
        }

        // Keep original description if not modified by region
        if (!userRegion) {
            personalizedManifest.description = originalManifest.description;
        }

        if (userProviders) {
            isPersonalized = true;
            const providersString = userProviders.split(',').map(p => p.trim().toLowerCase()).join(',');
            const providersConfigIndex = personalizedManifest.config.findIndex(c => c.key === 'selectedProviders');
            if (providersConfigIndex > -1) {
                personalizedManifest.config[providersConfigIndex].default = providersString;
            } else {
                personalizedManifest.config.push({
                    key: 'selectedProviders',
                    type: 'text',
                    title: 'Selected Providers (auto-set)',
                    default: providersString,
                    required: false,
                    // hidden: true // Temporarily remove hidden to observe in Stremio settings
                });
            }
            console.log(`[Manifest] Providers (${providersString}) will be part of the config.`);
        }

        // Handle minimum qualities
        if (global.currentRequestConfig.minQualities) {
            isPersonalized = true;
            const minQualitiesString = JSON.stringify(global.currentRequestConfig.minQualities);
            const minQualitiesConfigIndex = personalizedManifest.config.findIndex(c => c.key === 'minQualities');
            if (minQualitiesConfigIndex > -1) {
                personalizedManifest.config[minQualitiesConfigIndex].default = minQualitiesString;
            } else {
                personalizedManifest.config.push({
                    key: 'minQualities',
                    type: 'text',
                    title: 'Minimum Quality Settings (auto-set)',
                    default: minQualitiesString,
                    required: false,
                    hidden: true
                });
            }
            console.log(`[Manifest] Minimum qualities (${minQualitiesString}) will be part of the config.`);
        }

        // Handle Scraper API key
        if (global.currentRequestConfig.scraper_api_key) {
            isPersonalized = true;
            // Don't show the actual key in the manifest for security reasons
            personalizedManifest.config.push({
                key: 'hasScraperApiKey',
                type: 'text',
                title: 'ScraperAPI Key (Hidden for Security)',
                default: 'true',
                required: false,
                hidden: true
            });
            console.log(`[Manifest] ScraperAPI key will be part of the config.`);
        }

        if (isPersonalized) {
            // Create a simple identifier from the combination for the manifest ID
            let identifierSource = (userCookie || 'nocookie') + '-' + (userRegion || 'noregion') + '-' + (userProviders || 'allproviders');
            const hash = crypto.createHash('sha1').update(identifierSource).digest('hex').substring(0, 8);
            personalizedManifest.id = `${originalManifest.id}_${hash}`;
            console.log(`[Manifest] Personalized manifest ID set to: ${personalizedManifest.id}`);
        } else {
            // If no personalization, explicitly ensure no custom flags are set from previous logic
            delete personalizedManifest.isRegionPersonalized;
        }

        res.setHeader('Content-Type', 'application/json');
        res.send(JSON.stringify(personalizedManifest));

    } catch (error) {
        console.error('Error serving personalized manifest:', error);
        res.status(500).send('Error generating manifest');
    }
});

// REMOVE: Route for /setup as cookie configuration will be on index.html client-side
// app.get('/setup', (req, res) => { ... });

// The SDK's router takes care of addon functionality
const { getRouter } = require('stremio-addon-sdk');

// Custom router to make the user-supplied cookie available to the addon sdk handlers
const createCustomRouter = (currentAddonInterface) => {
    const originalRouter = getRouter(currentAddonInterface);

    return (req, res, next) => {
        // Make cookie available if provided
        if (req.userCookie) {
            global.currentRequestUserCookie = req.userCookie;
            console.log(`[server.js] Setting user cookie for this request (length: ${req.userCookie.length})`);
        }

        // Make region preference available if provided
        if (req.userRegion) {
            global.currentRequestRegionPreference = req.userRegion;
            console.log(`[server.js] Setting region preference for this request: ${req.userRegion}`);
        } else {
            // Reset for safety
            global.currentRequestRegionPreference = null;
        }

        res.on('finish', () => {
            // Clean up the global variables after the request is handled
            global.currentRequestUserCookie = null;
            global.currentRequestRegionPreference = null;
            console.log(`[server.js] Cleared cookie and region preference after request processing`);
        });

        return originalRouter(req, res, next);
    };
};

app.use(createCustomRouter(addonInterface));

// Add middleware to clean up global variables after the request is complete
app.use((req, res, next) => {
    // Store the original end function
    const originalEnd = res.end;

    // Override the end function to clean up globals after response is sent
    res.end = function () {
        // Call the original end function with all arguments
        originalEnd.apply(res, arguments);

        // Clean up global variables 
        if (global.currentRequestUserCookie || global.currentRequestRegionPreference) {
            console.log('Cleaning up global cookie and region preference after request');
            global.currentRequestUserCookie = null;
            global.currentRequestRegionPreference = null;
        }
    };

    next();
});

// Add a new endpoint to check region status and fallbacks
app.get('/api/region-status', (req, res) => {
    const status = {
        regionAvailability: global.regionAvailabilityStatus || {},
        usedFallback: global.usedRegionFallback || null,
        lastRequestedRegion: global.lastRequestedRegion || null
    };

    // Reset the fallback notification after it's been fetched once
    if (global.usedRegionFallback) {
        const fallbackInfo = { ...global.usedRegionFallback };
        global.usedRegionFallback = null;
        status.usedFallback = fallbackInfo;
    }

    res.json(status);
});

const PORT = process.env.PORT || 7777;

app.listen(PORT, () => {
    console.log(`Nuvio Streams Addon landing page available at http://localhost:${PORT}`);
    // console.log(`Cookie setup page available at http://localhost:${PORT}/setup`); // Removed
    const manifestUrl = `http://localhost:${PORT}/manifest.json`;
    console.log(`Default Addon Manifest available at: ${manifestUrl}`);
    console.log(`To generate a personalized manifest, append ?cookie=YOUR_URL_ENCODED_COOKIE to the manifest URL.`);
    console.log(`Example: http://localhost:${PORT}/manifest.json?cookie=ui%3Dyourcookievalue`);
    console.log(`Install example: stremio://localhost:${PORT}/manifest.json?cookie=ui%3Dyourcookievalue`);
}); 