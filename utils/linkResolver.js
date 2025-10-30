const cheerio = require('cheerio');
const { URL, URLSearchParams } = require('url');
const FormData = require('form-data');

function cleanTitle(title) {
  if (!title) return '';
  const parts = title.split(/\.|-|_/);
  const qualityTags = [
    "WEBRip", "WEB-DL", "WEB", "BluRay", "HDRip", "DVDRip", "HDTV",
    "CAM", "TS", "R5", "DVDScr", "BRRip", "BDRip", "DVD", "PDTV", "HD"
  ];
  const audioTags = [
    "AAC", "AC3", "DTS", "MP3", "FLAC", "DD5", "EAC3", "Atmos"
  ];
  const subTags = [
    "ESub", "ESubs", "Subs", "MultiSub", "NoSub", "EnglishSub", "HindiSub"
  ];
  const codecTags = [
    "x264", "x265", "H264", "HEVC", "AVC"
  ];

  const startIndex = parts.findIndex(part => qualityTags.some(tag => part.toLowerCase().includes(tag.toLowerCase())));
  const endIndex = (() => {
    let idx = -1;
    parts.forEach((part, i) => {
      if (
        subTags.some(tag => part.toLowerCase().includes(tag.toLowerCase())) ||
        audioTags.some(tag => part.toLowerCase().includes(tag.toLowerCase())) ||
        codecTags.some(tag => part.toLowerCase().includes(tag.toLowerCase()))
      ) idx = i;
    });
    return idx;
  })();

  if (startIndex !== -1 && endIndex !== -1 && endIndex >= startIndex) {
    return parts.slice(startIndex, endIndex + 1).join('.');
  } else if (startIndex !== -1) {
    return parts.slice(startIndex).join('.');
  } else {
    return parts.slice(-3).join('.');
  }
}

function getIndexQuality(str) {
  if (!str) return 0;
  const m = str.match(/(\d{3,4})[pP]/);
  if (m && m[1]) return parseInt(m[1], 10);
  return 0;
}

// Enhanced extraction for Driveleech/Driveseed pages, inspired by Kotlin logic
async function extractFinalDownloadFromFilePage($, {
  origin,
  get,
  post,
  validate,
  log = console,
}) {
  // Extract details from the DOM
  let fileName = '';
  let fileSize = '';
  let qualityText = '';

  // Try to find and extract file details
  const listItems = $('li.list-group-item');
  listItems.each((_, el) => {
    const txt = $(el).text();
    if (txt.toLowerCase().includes('name :')) fileName = txt.replace(/Name\s*:/i, '').trim();
    if (txt.toLowerCase().includes('size :')) fileSize = txt.replace(/Size\s*:/i, '').trim();
    qualityText = txt;
  });

  fileName = cleanTitle(fileName);
  const labelExtras = [fileName && `[${fileName}]`, fileSize && `[${fileSize}]`].filter(Boolean).join('');
  const qualityValue = getIndexQuality(qualityText);

  let foundLink = null;
  let foundLabel = null;
  let foundType = null;
  let foundQuality = qualityValue;

  // Collect anchors to process in async context
  const anchors = [];
  $('div.text-center > a').each((_, el) => {
    anchors.push({
      text: $(el).text(),
      href: $(el).attr('href'),
    });
  });
  
  for (const anchor of anchors) {
    const text = anchor.text;
    const href = anchor.href;
    log.debug && log.debug(`[Driveleech-KotlinJS] Parsing anchor: text='${text}' href='${href}'`);
    if (!href) continue;
    if (/instant download/i.test(text) && !foundLink) {
      foundType = 'Instant(Download)';
      foundLabel = `Driveleech Instant(Download) ${labelExtras}`.trim();
      foundQuality = qualityValue;
      // Accept direct CDN link (http/https, no url= required)
      if (/^https?:\/\//.test(href) && !href.includes('url=')) {
        foundLink = href;
        break;
      }
      // Otherwise only run old POST logic if url= is present
      try {
        const urlObj = new URL(href, origin);
        const keys = new URLSearchParams(urlObj.search).get('url');
        if (keys) {
          const apiUrl = `${urlObj.origin}/api`;
          const formData = new FormData();
          formData.append('keys', keys);
          if (post) {
            const resp = await post(apiUrl, formData, {
              headers: { ...formData.getHeaders(), 'x-token': urlObj.hostname }
            });
            if (resp && resp.data && resp.data.url && resp.data.url.startsWith('http')) {
              foundLink = resp.data.url.replace(/\s/g, '%20');
              break;
            }
          }
        }
      } catch (e) {
        log.log(`[Driveleech-KotlinJS] Error fetching instant download: ${e.message}`);
      }
    } else if (/resume worker bot/i.test(text) && !foundLink) {
      foundType = 'ResumeBot(VLC)';
      foundLabel = `Driveleech ResumeBot(VLC) ${labelExtras}`.trim();
      foundQuality = qualityValue;
      if (href.startsWith('http')) {
        foundLink = href;
        break;
      }
    } else if (/direct links/i.test(text) && !foundLink) {
      foundType = 'CF Type1';
      foundLabel = `Driveleech CF Type1 ${labelExtras}`.trim();
      foundQuality = qualityValue;
      // Not implemented
      // If implementing, put async/await req for '?type=1' here
    } else if (/resume cloud/i.test(text) && !foundLink) {
      foundType = 'ResumeCloud';
      foundLabel = `Driveleech ResumeCloud ${labelExtras}`.trim();
      foundQuality = qualityValue;
      try {
        const pageUrl = new URL(href, origin).href;
        if (get) {
          const res = await get(pageUrl);
          if (res && res.data) {
            const $$ = cheerio.load(res.data);
            const link = $$('a.btn-success').attr('href');
            if (link && link.startsWith('http')) {
              foundLink = link;
              break;
            }
          }
        }
      } catch (e) {
        log.log(`[Driveleech-KotlinJS] Error fetching ResumeCloud: ${e.message}`);
      }
    } else if (/cloud download/i.test(text) && !foundLink) {
      foundType = 'Cloud Download';
      foundLabel = `Driveleech Cloud Download ${labelExtras}`.trim();
      foundQuality = qualityValue;
      if (href.startsWith('http')) {
        foundLink = href;
        break;
      }
    }
  }

  if (!foundLink) {
    const fallback = $(
      'a[href*="workers.dev"], a[href*="workerseed"], a[href*="worker"], a[href*="driveleech.net/d/"], a[href*="driveseed.org/d/"]'
    ).attr('href');
    if (fallback && fallback.startsWith('http')) {
      foundType = 'Direct';
      foundLabel = `Driveleech Direct ${labelExtras}`.trim();
      foundQuality = qualityValue;
      foundLink = fallback;
    }
  }

  if (foundLink) {
    if (validate) {
      const ok = await validate(foundLink);
      if (!ok) {
        log.log("[Driveleech-KotlinJS] Extracted link failed validation");
        return null;
      }
    }
    log.log(
      `[Driveleech-KotlinJS] Extracted: url=${foundLink} label=${foundLabel || ''} quality=${foundQuality || ''}`
    );
    return {
      url: foundLink,
      label: foundLabel || '',
      quality: foundQuality || 0,
      fileName: fileName || '',
      fileSize: fileSize || '',
      type: foundType || '',
    };
  }
  log.log('[Driveleech-KotlinJS] Nothing extracted');
  return null;
}

async function followRedirectToFilePage({ redirectUrl, get, log = console }) {
  const res = await get(redirectUrl, { maxRedirects: 10 });
  let $ = cheerio.load(res.data);
  const scriptContent = $('script').html();
  const match = scriptContent && scriptContent.match(/window\.location\.replace\("([^"]+)"\)/);
  let finalFilePageUrl = redirectUrl;
  if (match && match[1]) {
    const base = new URL(redirectUrl).origin;
    finalFilePageUrl = new URL(match[1], base).href;
    log.log(`[LinkResolver] Redirect resolved to final file page: ${finalFilePageUrl}`);
    const finalRes = await get(finalFilePageUrl, { maxRedirects: 10 });
    $ = cheerio.load(finalRes.data);
  }
  return { $, finalFilePageUrl };
}

async function resolveSidToRedirect({ sidUrl, createSession, jar, log = console }) {
  const session = await createSession(jar);
  // Step 0
  const step0 = await session.get(sidUrl);
  let $ = cheerio.load(step0.data);
  const form0 = $('#landing');
  const wp_http = form0.find('input[name="_wp_http"]').val();
  const action0 = form0.attr('action');
  if (!wp_http || !action0) return null;
  // Step 1
  const step1 = await session.post(action0, new URLSearchParams({ '_wp_http': wp_http }), {
    headers: { 'Referer': sidUrl, 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  // Step 2
  $ = cheerio.load(step1.data);
  const form1 = $('#landing');
  const action1 = form1.attr('action');
  const wp_http2 = form1.find('input[name="_wp_http2"]').val();
  const token = form1.find('input[name="token"]').val();
  if (!action1) return null;
  const step2 = await session.post(action1, new URLSearchParams({ '_wp_http2': wp_http2, token }), {
    headers: { 'Referer': step1.request?.res?.responseUrl || sidUrl, 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  // Step 3 - meta refresh
  $ = cheerio.load(step2.data);
  const meta = $('meta[http-equiv="refresh"]').attr('content') || '';
  const m = meta.match(/url=(.*)/i);
  if (!m || !m[1]) return null;
  const origin = new URL(sidUrl).origin;
  const redirectUrl = new URL(m[1].replace(/"/g, '').replace(/'/g, ''), origin).href;
  log.log(`[LinkResolver] SID resolved to redirect: ${redirectUrl}`);
  return redirectUrl;
}

module.exports = {
  cleanTitle,
  getIndexQuality,
  extractFinalDownloadFromFilePage,
  followRedirectToFilePage,
  resolveSidToRedirect,
};






