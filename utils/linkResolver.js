const cheerio = require('cheerio');
const { URL, URLSearchParams } = require('url');
const FormData = require('form-data');

// Shared helpers for resolving driveseed/driveleech style redirects and extracting final download URLs.
// This util is proxy-agnostic: providers must inject their own network functions and validators.
// All functions accept injected dependencies so proxy, cookies, and caching stay in provider code.

// --- Default extractors (can be used directly or replaced by providers) ---

async function defaultTryInstantDownload($, { post, origin, log = console }) {
  const allInstant = $('a:contains("Instant Download"), a:contains("Instant")');
  log.log(`[LinkResolver] defaultTryInstantDownload: found ${allInstant.length} matching anchor(s).`);
  const instantLink = allInstant.attr('href');
  if (!instantLink) {
    log.log('[LinkResolver] defaultTryInstantDownload: no href on element.');
    return null;
  }

  try {
    const urlObj = new URL(instantLink, origin);
    const keys = new URLSearchParams(urlObj.search).get('url');
    if (!keys) return null;

    const apiUrl = `${urlObj.origin}/api`;
    const formData = new FormData();
    formData.append('keys', keys);

    const resp = await post(apiUrl, formData, {
      headers: { ...formData.getHeaders(), 'x-token': urlObj.hostname }
    });

    if (resp && resp.data && resp.data.url) {
      let finalUrl = resp.data.url;
      if (typeof finalUrl === 'string' && finalUrl.includes('workers.dev')) {
        const parts = finalUrl.split('/');
        const fn = parts[parts.length - 1];
        parts[parts.length - 1] = fn.replace(/ /g, '%20');
        finalUrl = parts.join('/');
      }
      log.log('[LinkResolver] defaultTryInstantDownload: extracted API url');
      return finalUrl;
    }
    return null;
  } catch (e) {
    log.log(`[LinkResolver] defaultTryInstantDownload error: ${e.message}`);
    return null;
  }
}

async function defaultTryResumeCloud($, { origin, get, validate, log = console }) {
  let resumeAnchor = $('a:contains("Resume Cloud"), a:contains("Cloud Resume Download"), a:contains("Resume Worker Bot"), a:contains("Worker")');
  log.log(`[LinkResolver] defaultTryResumeCloud: found ${resumeAnchor.length} candidate button(s).`);

  if (resumeAnchor.length === 0) {
    // Try direct links on page
    const direct = $('a[href*="workers.dev"], a[href*="workerseed"], a[href*="worker"], a[href*="driveleech.net/d/"], a[href*="driveseed.org/d/"]').attr('href');
    if (direct) {
      const ok = validate ? await validate(direct) : true;
      if (ok) return direct;
    }
    return null;
  }

  const href = resumeAnchor.attr('href');
  if (!href) return null;

  if (href.startsWith('http') || href.includes('workers.dev')) {
    const ok = validate ? await validate(href) : true;
    return ok ? href : null;
  }

  try {
    const resumeUrl = new URL(href, origin).href;
    const res = await get(resumeUrl, { maxRedirects: 10 });
    const $$ = cheerio.load(res.data);
    let finalDownloadLink = $$('a.btn-success[href*="workers.dev"], a[href*="workerseed"], a[href*="worker"], a[href*="driveleech.net/d/"], a[href*="driveseed.org/d/"]').attr('href');
    if (!finalDownloadLink) {
      finalDownloadLink = $$('a[href*="workers.dev"], a[href*="workerseed"], a[href*="worker"], a[href*="driveleech.net/d/"], a[href*="driveseed.org/d/"]').first().attr('href');
    }
    if (!finalDownloadLink) return null;
    const ok = validate ? await validate(finalDownloadLink) : true;
    return ok ? finalDownloadLink : null;
  } catch (e) {
    log.log(`[LinkResolver] defaultTryResumeCloud error: ${e.message}`);
    return null;
  }
}

// --- Core steps ---

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

async function extractFinalDownloadFromFilePage($, {
  origin,
  get,
  post,
  validate,
  log = console,
  tryResumeCloud = defaultTryResumeCloud,
  tryInstantDownload = defaultTryInstantDownload
}) {
  // Try known methods
  const methods = [
    async () => await tryResumeCloud($, { origin, get, validate, log }),
    async () => await tryInstantDownload($, { post, origin, log })
  ];

  for (const fn of methods) {
    try {
      const url = await fn();
      if (url) {
        const ok = validate ? await validate(url) : true;
        if (ok) return url;
      }
    } catch (e) {
      log.log(`[LinkResolver] method error: ${e.message}`);
    }
  }

  // Last resort: scan for plausible direct links
  let direct = $('a[href*="workers.dev"], a[href*="workerseed"], a[href*="worker"], a[href*="driveleech.net/d/"], a[href*="driveseed.org/d/"]').attr('href');
  if (direct) {
    const ok = validate ? await validate(direct) : true;
    if (ok) return direct;
  }
  return null;
}

// Resolve SID (tech.unblockedgames.world etc.) to intermediate redirect (driveleech/driveseed)
// createSession(jar) must return an axios-like instance with get/post that respects proxy and cookie jar
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
  defaultTryInstantDownload,
  defaultTryResumeCloud,
  followRedirectToFilePage,
  extractFinalDownloadFromFilePage,
  resolveSidToRedirect
};






