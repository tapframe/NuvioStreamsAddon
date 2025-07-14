# Cache Populator Script

This standalone script allows you to manually populate the cache for all four providers (TopMovies, UHDMovies, MoviesMod, and DramaDrip) by inputting TMDB IDs.

## Features

- **Interactive Mode**: Prompts for TMDB IDs one by one
- **Batch Mode**: Process multiple TMDB IDs from command line
- **Auto-detection**: Automatically detects if content is movie or TV series
- **TV Series Support**: Allows specifying season and episode numbers
- **Progress Tracking**: Shows detailed progress for each provider
- **Error Handling**: Graceful error handling with detailed messages

## Usage

### Interactive Mode

```bash
node cache_populator.js
```

This will start an interactive session where you can:
1. Enter TMDB IDs one by one
2. Specify media type (movie/tv) or let it auto-detect
3. For TV series, specify season and episode numbers
4. Continue adding more IDs or exit

### Batch Mode

```bash
# Single TMDB ID
node cache_populator.js 550

# Multiple TMDB IDs
node cache_populator.js 550 680 13 1245571
```

## Examples

### Popular Movies
```bash
# The Matrix (1999)
node cache_populator.js 603

# Inception (2010) 
node cache_populator.js 27205

# Interstellar (2014)
node cache_populator.js 157336
```

### TV Series
```bash
# Breaking Bad
node cache_populator.js 1396

# Game of Thrones
node cache_populator.js 1399

# The Office
node cache_populator.js 2316
```

## What It Does

1. **Fetches TMDB Details**: Gets movie/TV series information from TMDB API
2. **Processes All Providers**: Runs the caching logic for all four providers:
   - TopMovies
   - UHDMovies 
   - MoviesMod
   - DramaDrip
3. **Populates Cache**: Stores the final file page URLs in each provider's cache
4. **Shows Progress**: Displays detailed information about what was cached

## Output Example

```
🔄 Starting cache population for TMDB ID: 550
📺 Found: Fight Club (1999) - movie

🔍 Processing TopMovies...
✅ TopMovies: Cached 3 streams
   - TopMovies - 1080p (1080p (2.1GB))
   - TopMovies - 720p (720p (1.4GB))
   - TopMovies - 480p (480p (800MB))

🔍 Processing UHDMovies...
✅ UHDMovies: Cached 2 streams
   - UHDMovies - 1080p (1080p (2.5GB))
   - UHDMovies - 720p (720p (1.6GB))

🔍 Processing MoviesMod...
✅ MoviesMod: Cached 4 streams
   - MoviesMod - 1080p (1080p (2.2GB))
   - MoviesMod - 720p (720p (1.5GB))
   - MoviesMod - 480p (480p (900MB))
   - MoviesMod - 360p (360p (600MB))

🔍 Processing DramaDrip...
❌ DramaDrip: No streams found

✅ Cache population completed for TMDB ID: 550
```

## Requirements

- Node.js
- All provider dependencies (axios, cheerio, etc.)
- TMDB API key (set in environment or uses default)
- Internet connection

## Notes

- The script uses the same caching logic as the actual providers
- Cached data will be stored in the same cache directories used by the addon
- For TV series, you can specify season/episode or it defaults to S01E01
- The script will automatically detect if a TMDB ID is a movie or TV series
- Press Ctrl+C to exit at any time

## Troubleshooting

- **"Failed to fetch TMDB details"**: Check if the TMDB ID is valid
- **Provider errors**: Some providers may not have content for certain TMDB IDs
- **Network errors**: Ensure stable internet connection
- **Permission errors**: Make sure the script has write access to cache directories