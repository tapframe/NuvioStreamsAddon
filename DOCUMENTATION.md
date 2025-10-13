# Nuvio Streams Self-Hosting Guide

This guide will help you set up your own personal Nuvio Streams addon for Stremio. Don't worry if you're new to this - we'll go through each step clearly!

## What's In This Guide

- [Super Quick Start](#super-quick-start) - The fastest way to get up and running
- [Step-by-Step Installation](#step-by-step-installation) - Detailed instructions with explanations
- [Configuration Options](#configuration-options) - All the settings you can change
- [Troubleshooting](#troubleshooting) - Help if something goes wrong
- [Optimization Tips](#optimization-tips) - Making your addon run better
- [Complete Example](#complete-example) - Full configuration example

## Super Quick Start

If you just want to get things running fast:

1. Make sure you have [Node.js](https://nodejs.org/) installed (download the "LTS" version)
2. Open your terminal or command prompt
3. Run these commands:

```bash
# Get the code
git clone https://github.com/tapframe/NuvioStreamsAddon.git
cd NuvioStreamsAddon

# Install what's needed
npm install

# Copy the example settings file
cp .env.example .env

# IMPORTANT: Edit the .env file to add your TMDB API key and provider settings
# Open .env in any text editor and set TMDB_API_KEY=your_key_here (see Example .env below)

# Start the addon only AFTER setting up your .env file
npm start
```

4. Open `http://localhost:7000` in your browser
5. Install the addon in Stremio by clicking the "Install Addon" button

## Step-by-Step Installation

### What You'll Need

- **Computer** with internet access (Windows, Mac, or Linux)
- **Node.js** (version 16 or newer) - This runs the addon
- **npm** (comes with Node.js) - This helps install the needed files
- **TMDB API Key** - Required for movie/TV information
- **Basic computer skills** - Using terminal/command prompt, editing text files

### 1. Install Node.js

1. Visit [nodejs.org](https://nodejs.org/)
2. Download the "LTS" (Long Term Support) version
3. Follow the installation instructions for your operating system
4. To verify it's installed, open terminal/command prompt and type:
   ```bash
   node --version
   npm --version
   ```
   You should see version numbers for both

### 2. Get the Addon Code

1. Open terminal/command prompt
2. Navigate to where you want to store the addon
3. Run these commands:

```bash
# This downloads the code
git clone https://github.com/tapframe/NuvioStreamsAddon.git

# This moves into the downloaded folder
cd NuvioStreamsAddon
```

If you don't have `git` installed, you can:
- [Download the ZIP file](https://github.com/tapframe/NuvioStreamsAddon/archive/refs/heads/main.zip)
- Extract it to a folder
- Open terminal/command prompt and navigate to that folder

### 3. Install Dependencies

Dependencies are extra pieces of code the addon needs to work.

```bash
# This installs everything needed
npm install
```

This might take a minute or two. You'll see a progress bar and some text output.

### 4. Set Up Configuration File (.env)

This is the most important step! You need to create and edit a file called `.env` that contains all your settings.

1. First, copy the example configuration file:
   ```bash
   cp .env.example .env
   ```

2. Now open the `.env` file in any text editor (Notepad, VS Code, etc.)

3. Find and set the required TMDB API key:
   ```env
   TMDB_API_KEY=your_tmdb_api_key_here
   ```
   
   To get a TMDB API key:
   - Create a free account at [themoviedb.org](https://www.themoviedb.org/signup)
   - Go to [Settings → API](https://www.themoviedb.org/settings/api) after logging in
   - Request an API key for personal use
   - Copy the API key they give you

4. Configure providers and options. See the "Example .env" further below for a complete up-to-date template.

5. Enable caching for better performance:
   ```env
   # Cache settings - "false" means caching is ON
   DISABLE_CACHE=false
   DISABLE_STREAM_CACHE=false
   ```

6. Set up a ShowBox proxy (recommended):
   ```env
   # ShowBox often needs a proxy to work properly
   SHOWBOX_PROXY_URL_VALUE=https://your-proxy-url.netlify.app/?destination=
   ```
   
   To get a proxy URL:
   - Deploy a proxy using the button in the [Advanced Options](#advanced-options) section
   - Or use a public proxy (less reliable)

7. Save and close the file

### 5. Set Up ShowBox Cookie (Optional but Recommended)

For the best streaming experience:

1. Create a file named `cookies.txt` in the main folder
2. Add your ShowBox cookie to this file

#### Detailed Guide: How to Get ShowBox Cookie

1. **Create a FebBox account**:
   - Visit [FebBox.com](https://www.febbox.com)
   - Sign up using your Google account or email

2. **Log in to your account**

3. **Open developer tools in your browser**:
   - **Chrome/Edge**: Press `F12` or right-click anywhere and select "Inspect"
   - **Firefox**: Press `F12` or right-click and select "Inspect Element"
   - **Safari**: Enable developer tools in Preferences → Advanced, then press `Command+Option+I`

4. **Navigate to the cookies section**:
   - **Chrome/Edge**: Click on "Application" tab → expand "Storage" → "Cookies" → click on "febbox.com"
   - **Firefox**: Click on "Storage" tab → "Cookies" → select "febbox.com"
   - **Safari**: Click on "Storage" tab → "Cookies"

5. **Find the "ui" cookie**:
   - Look for a cookie named `ui` in the list
   - This is a long string that usually starts with "ey"
   - If you don't see it, try refreshing the page and checking again

6. **Copy the cookie value**:
   - Click on the `ui` cookie
   - Double-click the value field to select it all
   - Copy the entire string (Ctrl+C or Command+C)

7. **Paste into `cookies.txt`**:
   - Open/create the `cookies.txt` file in the root of your addon folder
   - Paste the cookie value (just the value, nothing else)
   - Save the file

**Visual Cues:**
- The `ui` cookie is usually the one with the longest value
- It typically starts with "ey" followed by many random characters
- The cookie value is what you need, not the cookie name

**Important Notes:**
- Cookies expire after some time, so you might need to repeat this process occasionally
- Each account gets its own 100GB monthly quota
- Using your own cookie gives you access to 4K/HDR/DV content
- With a personal cookie, streams will be faster and display a lightning indicator in the UI

### 6. Start the Addon

Now that you've configured everything, you can start the addon:

```bash
npm start
```

You should see output that ends with something like:
```
Addon running at: http://localhost:7000/manifest.json
```

### 7. Install in Stremio

1. Open your web browser and go to: `http://localhost:7000`
2. You'll see a page with an "Install Addon" button
3. Click the button - this will open Stremio with an installation prompt
4. Click "Install" in Stremio
5. That's it! The addon is now installed in your Stremio

## Configuration Options

Let's look at the important settings you can change in the `.env` file. Don't worry - we'll explain what each one does!

### Basic Settings (Most Important)

```env
# The only REQUIRED setting - get from themoviedb.org
TMDB_API_KEY=your_key_here
```

### Provider Settings

These control which streaming sources are active. Only currently supported providers are shown here. Set to true/false.

```env
# Core
ENABLE_VIDZEE_PROVIDER=true
ENABLE_MP4HYDRA_PROVIDER=true
ENABLE_UHDMOVIES_PROVIDER=true
ENABLE_MOVIESMOD_PROVIDER=true
ENABLE_TOPMOVIES_PROVIDER=true
ENABLE_MOVIESDRIVE_PROVIDER=true
ENABLE_4KHDHUB_PROVIDER=true
ENABLE_VIXSRC_PROVIDER=true
ENABLE_MOVIEBOX_PROVIDER=true
ENABLE_SOAPERTV_PROVIDER=true
```

| Provider | What It Offers | Notes |
|----------|----------------|-------|
| VidZee | Movies | General sources |
| MP4Hydra | Movies/TV | Multiple servers; quality tagged |
| UHDMovies | Movies | Good quality; supports external service mode |
| MoviesMod | Movies | Pre-formatted titles with rich metadata |
| TopMovies | Movies | Bollywood/regional focus |
| MoviesDrive | Movies | Direct links (e.g., Pixeldrain) |
| 4KHDHub | Movies/TV | Multiple servers; 4K/HDR/DV tagging |
| Vixsrc | Movies/TV | Alternative source |
| MovieBox | Movies/TV | General source |
| SoaperTV | TV | Episodic content |

### Performance Settings

These settings help your addon run faster and use less resources:

```env
# Cache settings - "false" means caching is ON (which is good)
DISABLE_CACHE=false
DISABLE_STREAM_CACHE=false
```

Caching saves previous searches and results, making everything faster!

### ShowBox Configuration

ShowBox is one of the best providers but needs a bit more setup:

#### Personal Cookie (Best Experience)

1. Create a file named `cookies.txt` in the main folder
2. Add your ShowBox cookie to this file

With your own cookie:
- You get your own 100GB monthly quota
- Access to higher quality streams (4K/HDR)
- Faster speeds

## Troubleshooting

### Common Problem: No Streams Found

**What to try:**
1. **Be patient** - sometimes it takes 30+ seconds to find streams
2. **Try again** - click the same movie/show again after a minute
3. **Check provider settings** - make sure providers are enabled

### Common Problem: Addon Won't Start

**What to try:**
1. Make sure Node.js is installed correctly
2. Check you've run `npm install`
3. Verify the `.env` file exists and has TMDB_API_KEY set
4. Look for error messages in the terminal

### Common Problem: Slow Performance

**What to try:**
1. Enable caching: Set `DISABLE_CACHE=false` and `DISABLE_STREAM_CACHE=false`
2. Use your own ShowBox cookie
3. Only enable the providers you actually use

### Common Problem: Cookie Not Working

**What to try:**
1. **Verify the cookie** - Make sure you copied the entire value
2. **Check for whitespace** - There should be no extra spaces before or after the cookie
3. **Get a fresh cookie** - Cookies expire, so you might need to get a new one
4. **Check the format** - The `cookies.txt` file should only contain the cookie value, nothing else
5. **Restart the addon** - After updating the cookie, restart the addon with `npm start`

## Running Your Addon All the Time

If you want your addon to keep running even when you close the terminal:

### Windows Method:

1. Create a file called `start.bat` with these contents:
   ```
   @echo off
   cd /d %~dp0
   npm start
   pause
   ```
2. Double-click this file to start your addon

### Using PM2 (Advanced):

```bash
# Install PM2
npm install -g pm2

# Start the addon with PM2
pm2 start npm --name "nuvio-streams" -- start

# Make it start when your computer restarts
pm2 save
pm2 startup
```

## Accessing From Other Devices

Once your addon is running, you can use it on any device on your home network:

1. Find your computer's IP address:
   - Windows: Type `ipconfig` in command prompt
   - Mac/Linux: Type `ifconfig` or `ip addr` in terminal
   
2. Use this address in Stremio on other devices:
   - Example: `http://192.168.1.100:7000/manifest.json`

## Optimization Tips

For the best experience:

1. **Enable caching** - Makes everything faster
   ```env
   DISABLE_CACHE=false
   DISABLE_STREAM_CACHE=false
   ```

2. **Use personal cookies** - Get your own bandwidth quota
   - Create and set up `cookies.txt` file

3. **Set up a ShowBox proxy** - Recommended for reliable streams
   ```env
   SHOWBOX_PROXY_URL_VALUE=https://your-proxy-url.netlify.app/?destination=
   ```

4. **Only enable providers you use** - Reduces search time
   - Turn off unused providers in your `.env` file

5. **Keep your addon updated**
   - Check for updates weekly:
   ```bash
   cd NuvioStreamsAddon
   git pull
   npm install
   ```

## Example .env (Aligned with this repo)

Use the following template, which matches the `.env` in this repository and the current code:

```env
# Cache Settings
DISABLE_CACHE=false
DISABLE_STREAM_CACHE=false
USE_REDIS_CACHE=false
REDIS_URL=

# Enable PStream (ShowBox-backed CDN) handling
ENABLE_PSTREAM_API=false

# URL Validation Settings
DISABLE_URL_VALIDATION=false
DISABLE_4KHDHUB_URL_VALIDATION=true

# ShowBox proxy rotation (recommended)
# Comma-separated list of edge proxies; each must end with ?destination=
SHOWBOX_PROXY_URLS=https://proxy-primary.example.workers.dev/?destination=,https://proxy-alt-1.example.workers.dev/?destination=,https://proxy-alt-2.example.workers.dev/?destination=

# FebBox proxy rotation (optional; used when resolving personal cookie calls)
FEBBOX_PROXY_URLS=https://proxy-primary.example.workers.dev/?destination=,https://proxy-alt-1.example.workers.dev/?destination=

# Provider-specific Proxy URLs (optional; leave empty for direct)
VIDSRC_PROXY_URL=
VIDZEE_PROXY_URL=
SOAPERTV_PROXY_URL=
UHDMOVIES_PROXY_URL=
MOVIESMOD_PROXY_URL=
TOPMOVIES_PROXY_URL=

# Provider Enablement
ENABLE_VIDZEE_PROVIDER=true
ENABLE_VIXSRC_PROVIDER=true
ENABLE_MP4HYDRA_PROVIDER=true
ENABLE_UHDMOVIES_PROVIDER=true
ENABLE_MOVIESMOD_PROVIDER=true
ENABLE_TOPMOVIES_PROVIDER=true
ENABLE_MOVIESDRIVE_PROVIDER=true
ENABLE_4KHDHUB_PROVIDER=true
ENABLE_MOVIEBOX_PROVIDER=true
ENABLE_SOAPERTV_PROVIDER=true

# API Keys
TMDB_API_KEY=your_tmdb_api_key_here

# External Provider Services
USE_EXTERNAL_PROVIDERS=false
EXTERNAL_UHDMOVIES_URL=
EXTERNAL_TOPMOVIES_URL=
EXTERNAL_MOVIESMOD_URL=

# Port configuration
PORT=7000
```

Important notes:
1. Replace `your_tmdb_api_key_here` with your actual TMDB API key
2. Replace proxy URLs with your deployed Cloudflare Workers (or Netlify) proxy URL(s)
3. The `cookies.txt` file is separate from this configuration and is auto-read by the addon
4. Only enable the providers you actually use
5. Uncomment lines (remove #) only if you need those features

### About ShowBox Personal Cookie and PStream

- Place your FebBox `ui` cookie value into `cookies.txt` at the project root (single-line value).
- With a valid cookie, the addon will:
  - Prefer faster ShowBox links and display a lightning icon next to ShowBox
  - Show your remaining quota on ShowBox/PStream entries when available
- PStream links (a ShowBox-backed CDN) appear as streaming sources and are not cached; they inherit ShowBox display conventions in the UI.

### ShowBox Multi-Proxy Setup (High Throughput)

To handle large numbers of requests or bursty traffic, configure multiple proxy endpoints and enable rotation:

1) Add multiple proxies in `.env` (as shown in the Example .env above). Use the `SHOWBOX_PROXY_URLS` comma-separated list for ShowBox, and `FEBBOX_PROXY_URLS` for FebBox calls when using a personal cookie:

```env
SHOWBOX_PROXY_URLS=https://proxy-primary.example.workers.dev/?destination=,https://proxy-alt-1.example.workers.dev/?destination=,https://proxy-alt-2.example.workers.dev/?destination=
FEBBOX_PROXY_URLS=https://proxy-primary.example.workers.dev/?destination=,https://proxy-alt-1.example.workers.dev/?destination=
```

- The addon round-robins across `SHOWBOX_PROXY_URLS` and `FEBBOX_PROXY_URLS` values automatically.
- Ensure each proxy ends with `?destination=` so the addon can append the upstream URL.

2) Recommended limits and best practices:
- Distribute traffic across multiple regions in Cloudflare to reduce egress concentration.
- Keep Workers simple (no heavy parsing) and forward only required headers.
- Consider enabling caching at the Worker/edge for static assets if appropriate (not for signed or user-specific URLs).

### Proxy Setup Notes

You may use your own HTTP edge proxy (for example on Cloudflare Workers or similar) as the target for `SHOWBOX_PROXY_URLS` and `FEBBOX_PROXY_URLS`. Ensure each proxy URL ends with `?destination=` and properly forwards method, headers, and body while adding permissive CORS for your deployment. Avoid copying proxy code here; follow your platform’s security best practices.

## Success

Congratulations! You now have your own personal streaming addon with:

- Multiple streaming sources
- Your own bandwidth quotas
- No limits on stream quality
- Full control over settings

Happy streaming!

---

## Advanced Options

*Note: This section is for more experienced users.*

If you want to dive deeper into configuration options, check these sections:

### Advanced Proxy Configuration

ShowBox usually requires a proxy to work properly in most regions:

```env
# Set up a proxy for ShowBox (recommended)
SHOWBOX_PROXY_URL_VALUE=https://your-proxy-url.netlify.app/?destination=
```

### Setting Up Proxies

1. Deploy: [![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/p-stream/simple-proxy)
2. Copy the deployed URL and add `?destination=` at the end
3. Add to your `.env` file as `SHOWBOX_PROXY_URL_VALUE=your-url/?destination=`

### Provider-Specific Proxies (optional)

```env
# Example placeholders (use only if you operate your own proxies)
VIDSRC_PROXY_URL=
VIDZEE_PROXY_URL=
SOAPERTV_PROXY_URL=
```

### External Provider Services

If you operate separate services that implement the addon’s external provider API for certain providers, you can point the addon to them:

```env
USE_EXTERNAL_PROVIDERS=true
EXTERNAL_UHDMOVIES_URL=https://your-uhdmovies-service.example.com
EXTERNAL_TOPMOVIES_URL=https://your-topmovies-service.example.com
EXTERNAL_MOVIESMOD_URL=https://your-moviesmod-service.example.com
```

