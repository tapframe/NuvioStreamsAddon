# Nuvio Streams Self-Hosting Guide for Beginners

This guide will help you set up your own personal Nuvio Streams addon for Stremio. Don't worry if you're new to this - we'll go through each step clearly!

## 📋 What's In This Guide

- [Super Quick Start](#super-quick-start) - The fastest way to get up and running
- [Step-by-Step Installation](#step-by-step-installation) - Detailed instructions with explanations
- [Configuration Options](#configuration-options) - All the settings you can change
- [Troubleshooting](#troubleshooting) - Help if something goes wrong
- [Optimization Tips](#optimization-tips) - Making your addon run better
- [Complete Example](#complete-example) - Full configuration example

## 💨 Super Quick Start

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

# IMPORTANT: Edit the .env file to add your TMDB API key
# Open .env in any text editor and set TMDB_API_KEY=your_key_here

# Start the addon only AFTER setting up your .env file
npm start
```

4. Open `http://localhost:7000` in your browser
5. Install the addon in Stremio by clicking the "Install Addon" button

## 📝 Step-by-Step Installation

### What You'll Need

- **Computer** with internet access (Windows, Mac, or Linux)
- **Node.js** (version 16 or newer) - This runs the addon
- **npm** (comes with Node.js) - This helps install the needed files
- **TMDB API Key** - Required for movie/TV information
- **Basic computer skills** - Using terminal/command prompt, editing text files

### 1️⃣ Install Node.js

1. Visit [nodejs.org](https://nodejs.org/)
2. Download the "LTS" (Long Term Support) version
3. Follow the installation instructions for your operating system
4. To verify it's installed, open terminal/command prompt and type:
   ```bash
   node --version
   npm --version
   ```
   You should see version numbers for both

### 2️⃣ Get the Addon Code

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

### 3️⃣ Install Dependencies

Dependencies are extra pieces of code the addon needs to work.

```bash
# This installs everything needed
npm install
```

This might take a minute or two. You'll see a progress bar and some text output.

### 4️⃣ Set Up Configuration File

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

4. Configure the providers you want to use:
   ```env
   # Enable or disable providers (true/false)
   ENABLE_VIDZEE_PROVIDER=true
   ENABLE_HOLLYMOVIEHD_PROVIDER=true
   ENABLE_XPRIME_PROVIDER=true
   ENABLE_CUEVANA_PROVIDER=false
   ```

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

### 5️⃣ Set Up ShowBox Cookie (Optional but Recommended)

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
- With a personal cookie, streams will be faster and show the ⚡ lightning emoji

### 6️⃣ Start the Addon

Now that you've configured everything, you can start the addon:

```bash
npm start
```

You should see output that ends with something like:
```
Addon running at: http://localhost:7000/manifest.json
```

### 7️⃣ Install in Stremio

1. Open your web browser and go to: `http://localhost:7000`
2. You'll see a page with an "Install Addon" button
3. Click the button - this will open Stremio with an installation prompt
4. Click "Install" in Stremio
5. That's it! The addon is now installed in your Stremio

## ⚙️ Configuration Options

Let's look at the important settings you can change in the `.env` file. Don't worry - we'll explain what each one does!

### Basic Settings (Most Important)

```env
# The only REQUIRED setting - get from themoviedb.org
TMDB_API_KEY=your_key_here
```

### Provider Settings

These control which streaming sources are active:

```env
# Turn providers on (true) or off (false)
ENABLE_VIDZEE_PROVIDER=true
ENABLE_HOLLYMOVIEHD_PROVIDER=true
ENABLE_XPRIME_PROVIDER=true
ENABLE_CUEVANA_PROVIDER=false
```

| Provider | What It Offers | Notes |
|----------|----------------|-------|
| VidZee | Movies | Easy to set up |
| HollyMovieHD | Movies & TV shows | Good quality |
| Xprime.tv | Movies & TV shows | Works best with personal setup |
| Cuevana | Spanish/LATAM content | Only works when self-hosting |

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

## 🚑 Troubleshooting

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

## 📱 Accessing From Other Devices

Once your addon is running, you can use it on any device on your home network:

1. Find your computer's IP address:
   - Windows: Type `ipconfig` in command prompt
   - Mac/Linux: Type `ifconfig` or `ip addr` in terminal
   
2. Use this address in Stremio on other devices:
   - Example: `http://192.168.1.100:7000/manifest.json`

## 💪 Optimization Tips

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

## 🔥 Complete Example

Here's a complete `.env` file example with all the common settings:

```env
# Required API key
TMDB_API_KEY=your_tmdb_api_key_here

# Cache Settings (recommended for better performance)
DISABLE_CACHE=false
DISABLE_STREAM_CACHE=false

# Provider Enablement (enable only what you need)
ENABLE_VIDZEE_PROVIDER=true
ENABLE_HOLLYMOVIEHD_PROVIDER=true
ENABLE_XPRIME_PROVIDER=true
ENABLE_CUEVANA_PROVIDER=false

# ShowBox Proxy Configuration (recommended)
SHOWBOX_PROXY_URL_VALUE=https://your-proxy-url.netlify.app/?destination=
# SHOWBOX_PROXY_URL_ALTERNATE=https://your-alternate-proxy.netlify.app/?destination=
# SHOWBOX_USE_ROTATING_PROXY=false

# HiAnime Configuration (if you want anime)
HIANIME_SERVER=http://localhost:8082/fetch-hianime

# Xprime Configuration (only if direct access fails)
USE_SCRAPER_API=false
# SCRAPER_API_KEY=your_key_here  # Uncomment if needed
```

Important notes:
1. Replace `your_tmdb_api_key_here` with your actual TMDB API key
2. Replace `your-proxy-url.netlify.app` with your actual proxy URL
3. The `cookies.txt` file is separate from this configuration
4. Only enable the providers you actually use
5. Uncomment lines (remove #) only if you need those features

## 🎉 Success!

Congratulations! You now have your own personal streaming addon with:

- ✅ Multiple streaming sources
- ✅ Your own bandwidth quotas
- ✅ No limits on stream quality
- ✅ Full control over settings

Happy streaming! 🍿

---

## 📚 Advanced Options

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

### Provider-Specific Proxies

```env
# Provider-specific Proxy URLs
VIDSRC_PROXY_URL=https://your-proxy-url.netlify.app/?destination=
VIDZEE_PROXY_URL=
SOAPERTV_PROXY_URL=
HOLLYMOVIEHD_PROXY_URL=
XPRIME_PROXY_URL=
```

### Xprime.tv with ScraperAPI

If you're not getting links from Xprime:

1. Get a free API key from [ScraperAPI.com](https://www.scraperapi.com/)
2. Add to your `.env` file:
   ```env
   USE_SCRAPER_API=true
   SCRAPER_API_KEY=your_key_here
   ```

### HiAnime Setup

For anime content:

```bash
# Setup Hianime service
cd providers/hianime
npm install
npm start

# In your main .env file
HIANIME_SERVER=http://localhost:8082/fetch-hianime
``` 