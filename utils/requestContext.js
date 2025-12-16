/**
 * Request Context using AsyncLocalStorage for per-request isolation
 * This ensures cookies and other request-specific data don't leak between concurrent requests
 */

const { AsyncLocalStorage } = require('async_hooks');

// Create the AsyncLocalStorage instance
const requestContext = new AsyncLocalStorage();

/**
 * Get the current request's config
 * @returns {Object} The current request config or empty object if not in a request context
 */
function getRequestConfig() {
    const store = requestContext.getStore();
    return store?.config || {};
}

/**
 * Set a value in the current request's config
 * @param {string} key - The key to set
 * @param {any} value - The value to set
 */
function setRequestConfigValue(key, value) {
    const store = requestContext.getStore();
    if (store && store.config) {
        store.config[key] = value;
    }
}

/**
 * Get a specific value from the current request's config
 * @param {string} key - The key to get
 * @param {any} defaultValue - Default value if key doesn't exist
 * @returns {any} The value or defaultValue
 */
function getRequestConfigValue(key, defaultValue = null) {
    const config = getRequestConfig();
    return config[key] !== undefined ? config[key] : defaultValue;
}

/**
 * Run a function within a request context
 * @param {Object} config - The request config to use
 * @param {Function} fn - The function to run
 * @returns {any} The result of the function
 */
function runWithRequestContext(config, fn) {
    return requestContext.run({ config }, fn);
}

/**
 * Express middleware to set up request context
 * @param {Object} config - The config object to use for this request
 * @returns {Function} Express middleware function
 */
function createRequestContextMiddleware() {
    return (req, res, next) => {
        // Initialize empty config - will be populated by other middleware
        const config = {};
        
        // Run the rest of the request within this context
        requestContext.run({ config }, () => {
            // Store reference on req for easy access in middleware
            req.nuvioConfig = config;
            next();
        });
    };
}

module.exports = {
    requestContext,
    getRequestConfig,
    setRequestConfigValue,
    getRequestConfigValue,
    runWithRequestContext,
    createRequestContextMiddleware
};
