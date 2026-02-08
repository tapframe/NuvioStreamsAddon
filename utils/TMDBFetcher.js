const { Mutex } = require('async-mutex');
const fetcher = require('./Fetcher');

/**
 * TMDB API wrapper with mutex locks to prevent duplicate requests
 * Ported from webstrymr/src/utils/tmdb.ts
 */
class TMDBFetcher {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.mutexes = new Map();
        this.imdbTmdbMap = new Map();
        this.tmdbImdbMap = new Map();
    }

    /**
     * Generic TMDB fetch with mutex locking
     */
    async tmdbFetch(path, searchParams = {}) {
        const url = new URL(`https://api.themoviedb.org/3${path}`);

        // Add search params
        Object.entries(searchParams).forEach(([name, value]) => {
            if (value) {
                url.searchParams.set(name, value);
            }
        });

        // Add API key
        url.searchParams.set('api_key', this.apiKey);

        // Get or create mutex for this exact URL
        let mutex = this.mutexes.get(url.href);
        if (!mutex) {
            mutex = new Mutex();
            this.mutexes.set(url.href, mutex);
        }

        // Lock and fetch
        const data = await mutex.runExclusive(async () => {
            return await fetcher.json(url.href, {
                headers: {
                    'Content-Type': 'application/json'
                },
                queueLimit: 50
            });
        });

        // Clean up mutex if not locked
        if (!mutex.isLocked()) {
            this.mutexes.delete(url.href);
        }

        return data;
    }

    /**
     * Get TMDB ID from IMDb ID
     */
    async getTmdbIdFromImdb(imdbId) {
        if (this.imdbTmdbMap.has(imdbId)) {
            return this.imdbTmdbMap.get(imdbId);
        }

        const response = await this.tmdbFetch(`/find/${imdbId}`, {
            external_source: 'imdb_id'
        });

        const id = response.tv_results?.[0]?.id || response.movie_results?.[0]?.id;

        if (!id) {
            throw new Error(`Could not get TMDB ID for IMDb ID "${imdbId}"`);
        }

        this.imdbTmdbMap.set(imdbId, id);
        return id;
    }

    /**
     * Get movie/TV details
     */
    async getDetails(tmdbId, type = 'tv', language = 'en-US') {
        return await this.tmdbFetch(`/${type}/${tmdbId}`, { language });
    }

    /**
     * Get external IDs
     */
    async getExternalIds(tmdbId, type = 'tv') {
        return await this.tmdbFetch(`/${type}/${tmdbId}/external_ids`);
    }

    /**
     * Get name and year from TMDB ID
     */
    async getNameAndYear(tmdbId, type = 'tv', language = 'en-US') {
        const details = await this.getDetails(tmdbId, type, language);

        if (type === 'tv') {
            return {
                name: details.name,
                year: new Date(details.first_air_date).getFullYear(),
                original_name: details.original_name
            };
        }

        return {
            name: details.title,
            year: new Date(details.release_date).getFullYear(),
            original_name: details.original_title
        };
    }
}

module.exports = TMDBFetcher;
