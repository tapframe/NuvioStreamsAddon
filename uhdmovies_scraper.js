/**
 * UHDMovies Scraper
 * 
 * This script scrapes movie links from uhdmovies.email
 */

const axios = require('axios');
const cheerio = require('cheerio');
const { URLSearchParams, URL } = require('url');
const FormData = require('form-data');
const fs = require('fs');
const readline = require('readline');


// Configure axios with headers to mimic a browser
const axiosInstance = axios.create({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'max-age=0'
  },
  timeout: 45000 // Increased timeout
});

// Global variable to store user's preferred method
let preferredMethod = 'instant';

// Global array to store all fetched links with metadata
let allFetchedLinks = [];

// Function to prompt user for download method preference
async function promptDownloadMethod() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    console.log('\n=== UHDMovies Scraper ===');
    console.log('Choose your preferred download method:');
    console.log('1. Instant Download (faster, direct Google Drive links)');
    console.log('2. Resume Cloud (alternative method)');
    console.log('');
    
    rl.question('Enter your choice (1 or 2): ', (answer) => {
      rl.close();
      if (answer.trim() === '2') {
        preferredMethod = 'resume';
        console.log('✓ Using Resume Cloud method\n');
      } else {
        preferredMethod = 'instant';
        console.log('✓ Using Instant Download method\n');
      }
      resolve();
    });
  });
}

// Main function to search for movies
async function searchMovies(query) {
  try {
    console.log(`Searching for: ${query}`);
    const searchUrl = `https://uhdmovies.email/search/${encodeURIComponent(query)}`;
    
    const response = await axiosInstance.get(searchUrl);
    const $ = cheerio.load(response.data);
    
    const searchResults = [];
    
    // Find all search result items
    $('a[href*="/download-"]').each((index, element) => {
      const link = $(element).attr('href');
      // Avoid duplicates by checking if link already exists in results
      if (link && !searchResults.some(item => item.link === link)) {
        const title = $(element).text().trim();
         if(title){
            searchResults.push({
                title,
                link
            });
         }
      }
    });
    
    console.log(`Found ${searchResults.length} results`);
    return searchResults;
  } catch (error) {
    console.error('Error searching movies:', error.message);
    return [];
  }
}

// Function to extract clean quality information from verbose text
function extractCleanQuality(fullQualityText) {
  if (!fullQualityText || fullQualityText === 'Unknown Quality') {
    return 'Unknown Quality';
  }
  
  const text = fullQualityText.toLowerCase();
  let quality = [];
  
  // Extract resolution
  if (text.includes('2160p') || text.includes('4k')) {
    quality.push('4K/2160p');
  } else if (text.includes('1080p')) {
    quality.push('1080p');
  } else if (text.includes('720p')) {
    quality.push('720p');
  } else if (text.includes('480p')) {
    quality.push('480p');
  }
  
  // Extract codec/format
  if (text.includes('hevc') || text.includes('x265')) {
    quality.push('HEVC/x265');
  } else if (text.includes('x264')) {
    quality.push('x264');
  }
  
  // Extract special features
  if (text.includes('hdr')) {
    quality.push('HDR');
  }
  if (text.includes('10bit')) {
    quality.push('10-bit');
  }
  if (text.includes('imax')) {
    quality.push('IMAX');
  }
  if (text.includes('web-dl') || text.includes('webdl')) {
    quality.push('WEB-DL');
  }
  if (text.includes('bluray') || text.includes('blu-ray')) {
    quality.push('BluRay');
  }
  
  // Extract audio info
  if (text.includes('dual audio') || (text.includes('hindi') && text.includes('english'))) {
    quality.push('Dual Audio');
  }
  
  // If we found any quality indicators, join them
  if (quality.length > 0) {
    return quality.join(' | ');
  }
  
  // Fallback: try to extract a shorter version of the original text
  // Look for patterns like "Movie Name (Year) Resolution ..."
  const patterns = [
    /(\d{3,4}p.*?(?:x264|x265|hevc).*?)[\[\(]/i,
    /(\d{3,4}p.*?)[\[\(]/i,
    /((?:720p|1080p|2160p|4k).*?)$/i
  ];
  
  for (const pattern of patterns) {
    const match = fullQualityText.match(pattern);
    if (match && match[1].trim().length < 100) {
      return match[1].trim();
    }
  }
  
  // Final fallback: truncate if too long
  if (fullQualityText.length > 80) {
    return fullQualityText.substring(0, 77) + '...';
  }
  
  return fullQualityText;
}

// Function to extract download links from a movie page
async function extractDownloadLinks(moviePageUrl) {
  try {
    console.log(`Extracting links from: ${moviePageUrl}`);
    const response = await axiosInstance.get(moviePageUrl);
    const $ = cheerio.load(response.data);
    
    const movieTitle = $('h1').first().text().trim();
    const downloadLinks = [];
    
    // Find all download links and their associated quality information
    $('a[href*="driveleech.net"]').each((index, element) => {
      const link = $(element).attr('href');
      
      if (link && !downloadLinks.some(item => item.link === link)) {
        let quality = 'Unknown Quality';
        let size = 'Unknown';
        
        // Method 1: Look for quality in the closest preceding paragraph or heading
        const prevElement = $(element).closest('p').prev();
        if (prevElement.length > 0) {
          const prevText = prevElement.text().trim();
          if (prevText && prevText.length > 20 && !prevText.includes('Download')) {
            quality = prevText;
          }
        }
        
        // Method 2: Look for quality in parent's siblings
        if (quality === 'Unknown Quality') {
          const parentSiblings = $(element).parent().prevAll().first().text().trim();
          if (parentSiblings && parentSiblings.length > 20) {
            quality = parentSiblings;
          }
        }
        
        // Method 3: Look for bold/strong text above the link
        if (quality === 'Unknown Quality') {
          const strongText = $(element).closest('p').prevAll().find('strong, b').last().text().trim();
          if (strongText && strongText.length > 20) {
            quality = strongText;
          }
        }
        
        // Method 4: Look for the entire paragraph containing quality info
        if (quality === 'Unknown Quality') {
          let currentElement = $(element).parent();
          for (let i = 0; i < 5; i++) {
            currentElement = currentElement.prev();
            if (currentElement.length === 0) break;
            
            const text = currentElement.text().trim();
            if (text && text.length > 30 && 
                (text.includes('1080p') || text.includes('720p') || text.includes('2160p') || 
                 text.includes('4K') || text.includes('HEVC') || text.includes('x264') || text.includes('x265'))) {
              quality = text;
              break;
            }
          }
        }
        
        // Extract size from quality text if present
        const sizeMatch = quality.match(/\[([0-9.,]+\s*[KMGT]B[^\]]*)\]/);
        if (sizeMatch) {
          size = sizeMatch[1];
        }
        
        // Clean up the quality information
        const cleanQuality = extractCleanQuality(quality);
        
        downloadLinks.push({
          quality: cleanQuality,
          size: size,
          link: link
        });
      }
    });
    
    return {
      title: movieTitle,
      links: downloadLinks
    };
    
  } catch (error) {
    console.error(`Error extracting download links: ${error.message}`);
    return { title: 'Unknown', links: [] };
  }
}

// Function to try Instant Download method
async function tryInstantDownload($) {
  const instantDownloadLink = $('a:contains("Instant Download")').attr('href');
  if (!instantDownloadLink) {
    console.log('  [LOG] No "Instant Download" button found.');
    return null;
  }

  console.log('Found "Instant Download" link, attempting to extract final URL...');
  
  try {
    const urlParams = new URLSearchParams(new URL(instantDownloadLink).search);
    const keys = urlParams.get('url');

    if (keys) {
        const apiUrl = `${new URL(instantDownloadLink).origin}/api`;
        const formData = new FormData();
        formData.append('keys', keys);

        const apiResponse = await axiosInstance.post(apiUrl, formData, {
            headers: {
                ...formData.getHeaders(),
                'x-token': new URL(instantDownloadLink).hostname
            }
        });

        if (apiResponse.data && apiResponse.data.url) {
            let finalUrl = apiResponse.data.url;
            // Fix spaces in workers.dev URLs by encoding them properly
            if (finalUrl.includes('workers.dev')) {
              const urlParts = finalUrl.split('/');
              const filename = urlParts[urlParts.length - 1];
              const encodedFilename = filename.replace(/ /g, '%20');
              urlParts[urlParts.length - 1] = encodedFilename;
              finalUrl = urlParts.join('/');
            }
            console.log('Extracted final link from API:', finalUrl);
            return finalUrl;
        }
    }
    
    console.log('Could not find a valid final download link from Instant Download.');
    return null;
  } catch (error) {
    console.log(`Error processing "Instant Download": ${error.message}`);
    return null;
  }
}

// Function to try Resume Cloud method
async function tryResumeCloud($) {
  // Look for both "Resume Cloud" and "Cloud Resume Download" buttons
  const resumeCloudButton = $('a:contains("Resume Cloud"), a:contains("Cloud Resume Download")');
  
  if (resumeCloudButton.length === 0) {
    console.log('  [LOG] No "Resume Cloud" or "Cloud Resume Download" button found.');
    return null;
  }

  const resumeLink = resumeCloudButton.attr('href');
  if (!resumeLink) {
    console.log('  [LOG] Resume Cloud button found but no href attribute.');
    return null;
  }

  // Check if it's already a direct download link (workers.dev)
  if (resumeLink.includes('workers.dev') || resumeLink.startsWith('http')) {
    let directLink = resumeLink;
    // Fix spaces in workers.dev URLs by encoding them properly
    if (directLink.includes('workers.dev')) {
      const urlParts = directLink.split('/');
      const filename = urlParts[urlParts.length - 1];
      const encodedFilename = filename.replace(/ /g, '%20');
      urlParts[urlParts.length - 1] = encodedFilename;
      directLink = urlParts.join('/');
    }
    console.log(`  [LOG] Found direct "Cloud Resume Download" link: ${directLink}`);
    return directLink;
  }

  // Otherwise, follow the link to get the final download
  try {
    const resumeUrl = new URL(resumeLink, 'https://driveleech.net').href;
    console.log(`  [LOG] Found 'Resume Cloud' page link. Following to: ${resumeUrl}`);
    
    // "Click" the link by making another request
    const finalPageResponse = await axiosInstance.get(resumeUrl, { maxRedirects: 10 });
    const $$ = cheerio.load(finalPageResponse.data);

    // Save the final page for inspection
    fs.writeFileSync('driveleech_final_page.html', finalPageResponse.data);
    console.log('  [LOG] Saved the final page HTML to driveleech_final_page.html');

    // Look for direct download links
    let finalDownloadLink = $$('a.btn-success[href*="workers.dev"], a[href*="driveleech.net/d/"]').attr('href');

    if (finalDownloadLink) {
      // Fix spaces in workers.dev URLs by encoding them properly
      if (finalDownloadLink.includes('workers.dev')) {
        // Split the URL at the last slash to separate the base URL from the filename
        const urlParts = finalDownloadLink.split('/');
        const filename = urlParts[urlParts.length - 1];
        // Encode spaces in the filename part only
        const encodedFilename = filename.replace(/ /g, '%20');
        urlParts[urlParts.length - 1] = encodedFilename;
        finalDownloadLink = urlParts.join('/');
      }
      console.log(`  [LOG] Extracted final Resume Cloud link: ${finalDownloadLink}`);
      return finalDownloadLink;
    } else {
      console.log('  [LOG] Could not find the final download link on the "Resume Cloud" page.');
      return null;
    }
  } catch (error) {
    console.log(`Error processing "Resume Cloud": ${error.message}`);
    return null;
  }
}

// Function to follow redirect links and get the final download URL with size info
async function getFinalLink(redirectUrl) {
  try {
    console.log(`Following redirect: ${redirectUrl}`);
    
    // Request the driveleech page
    let response = await axiosInstance.get(redirectUrl, { maxRedirects: 10 });
    let $ = cheerio.load(response.data);

    // --- Check for JavaScript redirect ---
    const scriptContent = $('script').html();
    const redirectMatch = scriptContent && scriptContent.match(/window\.location\.replace\("([^"]+)"\)/);

    if (redirectMatch && redirectMatch[1]) {
        const newPath = redirectMatch[1];
        const newUrl = new URL(newPath, 'https://driveleech.net/').href;
        console.log(`  [LOG] Found JavaScript redirect. Following to: ${newUrl}`);
        response = await axiosInstance.get(newUrl, { maxRedirects: 10 });
        $ = cheerio.load(response.data);
    }
    // --- End of JS redirect handling ---

    // Extract size information from the page
    let sizeInfo = 'Unknown';
    const sizeElement = $('li:contains("Size")').text();
    if (sizeElement) {
      const sizeMatch = sizeElement.match(/Size\s*:\s*([0-9.,]+\s*[KMGT]B)/);
      if (sizeMatch) {
        sizeInfo = sizeMatch[1];
      }
    }

    // --- Added for more detailed logging ---
    console.log(`  [LOG] Page Title: ${$('title').text().trim()}`);
    console.log(`  [LOG] File Size: ${sizeInfo}`);
    console.log(`  [LOG] HTML content length: ${response.data.length} characters.`);
    const resumeCloudButton = $('a:contains("Resume Cloud"), a:contains("Cloud Resume Download")');
    console.log(`  [LOG] Searching for Resume Cloud buttons... Found ${resumeCloudButton.length} elements.`);
    const instantDownloadButton = $('a:contains("Instant Download")');
    console.log(`  [LOG] Searching for "Instant Download" button... Found ${instantDownloadButton.length} elements.`);
    // --- End of logging ---

    // Save the downloaded HTML to a file for inspection
    fs.writeFileSync('driveleech_page_from_script.html', response.data);
    console.log('  [LOG] Saved the received HTML to driveleech_page_from_script.html for inspection.');

    // Use the method chosen by the user
    let finalUrl = null;
    if (preferredMethod === 'instant') {
      // Try Instant Download first
      finalUrl = await tryInstantDownload($);
      if (finalUrl) return { url: finalUrl, size: sizeInfo };
      
      // Fallback to Resume Cloud
      console.log('  [LOG] "Instant Download" failed, trying "Resume Cloud" fallback.');
      finalUrl = await tryResumeCloud($);
      if (finalUrl) return { url: finalUrl, size: sizeInfo };
    } else {
      // Try Resume Cloud first
      finalUrl = await tryResumeCloud($);
      if (finalUrl) return { url: finalUrl, size: sizeInfo };
      
      // Fallback to Instant Download
      console.log('  [LOG] "Resume Cloud" failed, trying "Instant Download" fallback.');
      finalUrl = await tryInstantDownload($);
      if (finalUrl) return { url: finalUrl, size: sizeInfo };
    }

    console.log('Both "Instant Download" and "Resume Cloud" methods failed.');
    return null;

  } catch (error) {
    console.error('Error in getFinalLink:', error.message);
    return null;
  }
}

// Function to add a fetched link to our collection
function addFetchedLink(movieTitle, quality, finalUrl, size = 'Unknown') {
  allFetchedLinks.push({
    movieTitle: movieTitle,
    quality: quality,
    size: size,
    finalUrl: finalUrl,
    method: preferredMethod === 'instant' ? 'Instant Download' : 'Resume Cloud'
  });
}

// Function to display all fetched links summary
function displayLinksSummary() {
  console.log('\n' + '='.repeat(80));
  console.log('🎬 DOWNLOAD LINKS SUMMARY');
  console.log('='.repeat(80));
  
  if (allFetchedLinks.length === 0) {
    console.log('❌ No download links were successfully fetched.');
    return;
  }

  console.log(`✅ Successfully fetched ${allFetchedLinks.length} download link(s):\n`);

  allFetchedLinks.forEach((link, index) => {
    console.log(`📁 Link #${index + 1}`);
    console.log(`   Movie: ${link.movieTitle}`);
    console.log(`   Quality: ${link.quality}`);
    console.log(`   Size: ${link.size}`);
    console.log(`   Method: ${link.method}`);
    console.log(`   URL: ${link.finalUrl}`);
    console.log('');
  });

  console.log('='.repeat(80));
  console.log(`📊 Total: ${allFetchedLinks.length} links | Method: ${preferredMethod === 'instant' ? 'Instant Download' : 'Resume Cloud'}`);
  console.log('='.repeat(80));
}

// Main execution function
async function main() {
  try {
    // Get user's preferred download method
    await promptDownloadMethod();
    
    const query = process.argv[2];
    if (!query) {
      console.log('Usage: node uhdmovies_scraper.js "search query"');
      console.log('Example: node uhdmovies_scraper.js "avengers endgame"');
      return;
    }

    console.log(`Starting search for: "${query}"`);
    const searchResults = await searchMovies(query);
  
    if (searchResults.length === 0) {
      console.log('No movies found for the given query.');
      return;
    }

    console.log('Extracting download links for the first result...');
    const downloadInfo = await extractDownloadLinks(searchResults[0].link);
    
    console.log(`\nMovie: ${downloadInfo.title}\n`);

    if (downloadInfo.links.length === 0) {
      console.log('No download links found.');
      return;
    }

    // Process all links in parallel for much faster performance
    console.log(`Processing ${downloadInfo.links.length} download links in parallel...`);
    
    const linkPromises = downloadInfo.links.map(async (link, index) => {
      console.log(`\nQuality: ${link.quality}`);
      console.log(`Intermediate Link: ${link.link}`);
      
      try {
        const finalLink = await getFinalLink(link.link);
        if (finalLink) {
          console.log(`>>>> Final Download Link: ${finalLink.url}`);
          addFetchedLink(downloadInfo.title, link.quality, finalLink.url, finalLink.size);
          return { success: true, quality: link.quality, url: finalLink.url };
        } else {
          console.log('>>>> Could not retrieve final link.');
          return { success: false, quality: link.quality };
        }
      } catch (error) {
        console.log(`>>>> Error processing link: ${error.message}`);
        return { success: false, quality: link.quality, error: error.message };
      }
    });

    // Wait for all parallel processing to complete
    console.log('\n⏳ Waiting for all downloads to complete...');
    const results = await Promise.all(linkPromises);
    
    // Log summary of parallel processing
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    console.log(`\n✅ Parallel processing complete: ${successful} successful, ${failed} failed`);

    // Display all fetched links summary
    displayLinksSummary();
  } catch (error) {
    console.error('An error occurred:', error);
  }
}

// Run the main function
if (require.main === module) {
  main().catch(error => {
    console.error('An error occurred:', error);
  });
}

module.exports = {
  searchMovies,
  extractDownloadLinks
}; 