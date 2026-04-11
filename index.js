const axios = require('axios');
const cheerio = require('cheerio');
const dns = require('dns');
const fs = require('fs-extra');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const { terminal: term } = require('terminal-kit');
const EpubGen = require('epub-gen-memory').default;
const VALVRARE_ORIGIN = 'https://valvrareteam.net';
const VALVRARE_DIRECTORY_CACHE_TTL_MS = 10 * 60 * 1000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'vi,en-US;q=0.9,en;q=0.8',
  Referer: 'https://docln.net/'
};

const SITE_ORIGINS = [
  'https://docln.net',
  'https://docln.sbs',
  'https://ln.hako.vn',
  VALVRARE_ORIGIN
];

const DNS_PROFILES = {
  system: { id: 'system', label: 'He thong mac dinh', servers: null },
  cloudflare: { id: 'cloudflare', label: 'Cloudflare (1.1.1.1, 1.0.0.1)', servers: ['1.1.1.1', '1.0.0.1'] },
  google: { id: 'google', label: 'Google (8.8.8.8, 8.8.4.4)', servers: ['8.8.8.8', '8.8.4.4'] }
};

const EPUB_MODES = [
  { id: '0', label: 'Chi tai TXT, khong tao EPUB' },
  { id: '1', label: '1 file EPUB cho tat ca tap' },
  { id: '2', label: '1 file EPUB cho moi tap' },
  { id: '3', label: 'Ca 2 kieu EPUB' }
];

const NAV_TEXT_BLACKLIST = new Set([
  '',
  'xem them',
  'dang nhap',
  'lich su',
  'thao luan',
  'sang tac',
  'ai dich',
  'xuat ban',
  'danh sach',
  'thong tin',
  'chu y',
  'donate',
  'top thang',
  'toan t/gian',
  'truyen vua doc'
]);

let activeOrigin = SITE_ORIGINS[0];
let dnsProfile = createDnsProfile(DNS_PROFILES.system.label, DNS_PROFILES.system.servers, DNS_PROFILES.system.id);
let httpClient;
let terminalImageModulePromise;
let terminalGraphicsSupportPromise;
let valvrareDirectoryCache = null;

applyDnsProfile(DNS_PROFILES.system);

function createDnsProfile(label, servers, id = 'custom') {
  return {
    id,
    label,
    servers: Array.isArray(servers) && servers.length > 0 ? [...servers] : null
  };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeFileName(value) {
  const normalized = String(value || '').normalize('NFC');
  const sanitized = normalized
    .replace(/[\/\\?%*:|"<>]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim();

  const safeValue = sanitized || 'untitled';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(safeValue)
    ? `_${safeValue}`
    : safeValue;
}

function normalizeWhitespace(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function normalizeSearchText(value) {
  return normalizeWhitespace(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function truncate(value, width) {
  if (!value || value.length <= width) return value;
  if (width <= 3) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
}

function isNovelPath(pathname) {
  return /^\/truyen\/\d+(?:-[^/?#]+)?\/?$/.test(pathname)
    || /^\/truyen\/[^/?#]+\/?$/.test(pathname);
}

function isValvrareOrigin(origin) {
  return origin === VALVRARE_ORIGIN;
}

function isValvrareDirectoryPath(pathname) {
  return /^\/danh-sach-truyen(?:\/trang\/\d+)?\/?$/.test(pathname);
}

function isValvrareDirectoryUrl(href) {
  if (!href) return false;

  try {
    const url = new URL(href, VALVRARE_ORIGIN);
    return isValvrareOrigin(url.origin) && isValvrareDirectoryPath(url.pathname);
  } catch {
    return false;
  }
}

function isNovelHref(href) {
  if (!href) return false;

  try {
    const url = new URL(href, activeOrigin);
    return isNovelPath(url.pathname);
  } catch {
    return false;
  }
}

function normalizeUrl(href, baseUrl = activeOrigin) {
  if (!href) return '';

  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return '';
  }
}

function normalizeNovelUrl(href, baseUrl = activeOrigin) {
  const normalized = normalizeUrl(href, baseUrl);
  if (!normalized) return '';

  try {
    const url = new URL(normalized);
    if (isNovelPath(url.pathname)) {
      url.search = '';
      url.hash = '';
    }
    return url.toString();
  } catch {
    return normalized;
  }
}

function extractImageUrlFromStyle(styleValue = '') {
  return styleValue.match(/url\(['"]?(.*?)['"]?\)/)?.[1] || '';
}

function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return activeOrigin;
  }
}

function buildRequestHeaders(targetUrl) {
  const targetOrigin = getOrigin(targetUrl);
  const refererOrigin = isSiteOrigin(targetOrigin) ? targetOrigin : activeOrigin;

  return {
    ...HEADERS,
    Referer: `${refererOrigin}/`
  };
}

function isSiteOrigin(origin) {
  return SITE_ORIGINS.includes(origin);
}

function getFinalResponseUrl(response, fallbackUrl) {
  return response?.request?.res?.responseUrl || fallbackUrl;
}

function collectErrorMessages(error, messages = [], seen = new Set()) {
  if (!error || seen.has(error)) return messages;
  seen.add(error);

  const message = typeof error === 'string'
    ? error
    : error.message || error.code || String(error);

  if (message && !messages.includes(message)) {
    messages.push(message);
  }

  if (Array.isArray(error.errors)) {
    error.errors.forEach(child => collectErrorMessages(child, messages, seen));
  }

  if (error.cause) {
    collectErrorMessages(error.cause, messages, seen);
  }

  return messages;
}

function formatErrorMessage(error) {
  const messages = collectErrorMessages(error);
  if (messages.length === 0) return 'Loi khong xac dinh';
  if (messages.length === 1) return messages[0];
  return messages.slice(0, 4).join('\n- ');
}

function isNoDataError(error) {
  return error && ['ENOTFOUND', 'ENODATA', 'EAI_NODATA'].includes(error.code);
}

function isLocalHostname(hostname) {
  return hostname === 'localhost' || hostname.endsWith('.local');
}

async function resolveWithCustomDns(resolver, hostname, family, all) {
  const resolveFamily = async targetFamily => {
    const addresses = targetFamily === 6
      ? await resolver.resolve6(hostname)
      : await resolver.resolve4(hostname);
    return addresses.map(address => ({ address, family: targetFamily }));
  };

  if (family === 4 || family === 6) return resolveFamily(family);

  if (!all) {
    try {
      return await resolveFamily(4);
    } catch (error) {
      if (!isNoDataError(error)) throw error;
      return resolveFamily(6);
    }
  }

  const records = [];
  let firstError = null;

  for (const targetFamily of [4, 6]) {
    try {
      records.push(...await resolveFamily(targetFamily));
    } catch (error) {
      if (!firstError) firstError = error;
      if (!isNoDataError(error)) throw error;
    }
  }

  if (records.length > 0) return records;
  throw firstError || new Error(`DNS lookup failed for ${hostname}`);
}

function createLookup(servers) {
  if (!servers || servers.length === 0) return dns.lookup;

  const resolver = new dns.promises.Resolver();
  resolver.setServers(servers);

  return function customLookup(hostname, options, callback) {
    let lookupOptions = options;
    let done = callback;

    if (typeof lookupOptions === 'function') {
      done = lookupOptions;
      lookupOptions = {};
    } else if (typeof lookupOptions === 'number') {
      lookupOptions = { family: lookupOptions };
    } else {
      lookupOptions = lookupOptions || {};
    }

    const ipFamily = net.isIP(hostname);
    if (ipFamily) {
      if (lookupOptions.all) {
        done(null, [{ address: hostname, family: ipFamily }]);
        return;
      }

      done(null, hostname, ipFamily);
      return;
    }

    if (isLocalHostname(hostname)) {
      dns.lookup(hostname, lookupOptions, done);
      return;
    }

    resolveWithCustomDns(resolver, hostname, lookupOptions.family, Boolean(lookupOptions.all))
      .then(records => {
        if (lookupOptions.all) {
          done(null, records);
          return;
        }

        done(null, records[0].address, records[0].family);
      })
      .catch(done);
  };
}

function createHttpClient(lookup) {
  return axios.create({
    headers: HEADERS,
    timeout: 30000,
    maxRedirects: 5,
    httpAgent: new http.Agent({ lookup }),
    httpsAgent: new https.Agent({ lookup }),
    validateStatus: status => status >= 200 && status < 400
  });
}

function applyDnsProfile(profile) {
  dnsProfile = createDnsProfile(profile.label, profile.servers, profile.id || 'custom');
  const lookup = createLookup(dnsProfile.servers);
  httpClient = createHttpClient(lookup);
}

function getDnsStatusLabel() {
  return dnsProfile.label;
}

function getStatusLine() {
  return `Site: ${activeOrigin} | DNS: ${getDnsStatusLabel()}`;
}

function extractAnchorTitle($, anchor) {
  const anchorNode = $(anchor);
  return normalizeWhitespace(
    anchorNode.attr('title') ||
    anchorNode.find('img').first().attr('alt') ||
    anchorNode.text()
  );
}

function extractAnchorImage($, anchor, pageUrl) {
  const anchorNode = $(anchor);
  const nearbyImageNode = anchorNode.find('.img-in-ratio').first().length > 0
    ? anchorNode.find('.img-in-ratio').first()
    : anchorNode.parent().find('.img-in-ratio').first().length > 0
      ? anchorNode.parent().find('.img-in-ratio').first()
      : anchorNode.parents('.thumb-wrapper, .series-cover, .thumb-item-flow, .popular-thumb-item').first().find('.img-in-ratio').first();

  const imageUrl = anchorNode.find('img').first().attr('data-src')
    || anchorNode.find('img').first().attr('src')
    || nearbyImageNode.attr('data-bg')
    || extractImageUrlFromStyle(nearbyImageNode.attr('style') || '')
    || '';
  return imageUrl ? normalizeUrl(imageUrl, pageUrl) : '';
}

function aggregateNovelItems(items) {
  const map = new Map();

  items.forEach((item, index) => {
    if (!item.url) return;

    const existing = map.get(item.url);

    if (!existing) {
      map.set(item.url, {
        ...item,
        firstIndex: index,
        count: 1
      });
      return;
    }

    existing.count += 1;
    if (!existing.title && item.title) existing.title = item.title;
    if (!existing.imageUrl && item.imageUrl) existing.imageUrl = item.imageUrl;
    if (!existing.summary && item.summary) existing.summary = item.summary;
    if (!existing.badge && item.badge) existing.badge = item.badge;
  });

  return [...map.values()].filter(item => item.title && !NAV_TEXT_BLACKLIST.has(normalizeSearchText(item.title)));
}

function extractNovelCandidatesFromHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  const items = [];

  $('a[href]').each((_, anchor) => {
    const href = $(anchor).attr('href');
    if (!isNovelHref(href)) return;

    const title = extractAnchorTitle($, anchor);
    const imageUrl = extractAnchorImage($, anchor, pageUrl);
    const url = normalizeNovelUrl(href, pageUrl);

    if (!url) return;

    items.push({
      title,
      imageUrl,
      url
    });
  });

  return aggregateNovelItems(items);
}

function extractValvrareDirectoryItems(html, pageUrl) {
  const $ = cheerio.load(html);
  const items = [];

  $('.nd-novel-card').each((_, card) => {
    const cardNode = $(card);
    const titleAnchor = cardNode.find('.nd-novel-title-link[href]').first();
    const imageAnchor = cardNode.find('.nd-novel-image-link[href]').first();
    const href = titleAnchor.attr('href') || imageAnchor.attr('href');
    const url = normalizeNovelUrl(href, pageUrl);
    const title = normalizeWhitespace(
      cardNode.find('.nd-novel-title').first().text()
      || titleAnchor.attr('title')
      || titleAnchor.text()
      || imageAnchor.find('img').first().attr('alt')
    );

    if (!url || !title) return;

    const imageNode = cardNode.find('.nd-novel-image img').first();
    const imageUrl = normalizeUrl(
      imageNode.attr('src')
      || imageNode.attr('data-src')
      || '',
      pageUrl
    );
    const summary = normalizeWhitespace(cardNode.find('.nd-novel-description').first().text());

    items.push({
      title,
      imageUrl,
      summary,
      badge: 'Danh mục',
      url
    });
  });

  return items;
}

function extractValvrareDirectoryMeta(html) {
  const $ = cheerio.load(html);
  let totalPages = 0;
  let totalItems = 0;

  $('.nd-pagination a[href*="/danh-sach-truyen/trang/"]').each((_, anchor) => {
    const href = $(anchor).attr('href') || '';
    const hrefMatch = href.match(/\/trang\/(\d+)/);
    const hrefPage = Number.parseInt(hrefMatch?.[1] || '', 10);
    const textPage = Number.parseInt(normalizeWhitespace($(anchor).text()), 10);

    if (Number.isInteger(hrefPage)) {
      totalPages = Math.max(totalPages, hrefPage);
    }

    if (Number.isInteger(textPage)) {
      totalPages = Math.max(totalPages, textPage);
    }
  });

  const totalPagesMatch = html.match(/"totalPages":(\d+)/);
  const totalItemsMatch = html.match(/"totalItems":(\d+)/);
  const headingMatch = normalizeWhitespace($('.nd-section-headers h2').first().text()).match(/\((\d+)\)/);

  if (totalPagesMatch) {
    totalPages = Math.max(totalPages, Number.parseInt(totalPagesMatch[1], 10) || 0);
  }

  if (totalItemsMatch) {
    totalItems = Number.parseInt(totalItemsMatch[1], 10) || 0;
  }

  if (!totalItems && headingMatch) {
    totalItems = Number.parseInt(headingMatch[1], 10) || 0;
  }

  return {
    totalPages: Math.max(totalPages, 1),
    totalItems
  };
}

function getCachedValvrareDirectory() {
  if (!valvrareDirectoryCache) return null;

  if (Date.now() - valvrareDirectoryCache.timestamp > VALVRARE_DIRECTORY_CACHE_TTL_MS) {
    valvrareDirectoryCache = null;
    return null;
  }

  return valvrareDirectoryCache;
}

function buildValvrareDirectoryPageUrl(pageNumber = 1) {
  return normalizeUrl(`/danh-sach-truyen/trang/${pageNumber}`, VALVRARE_ORIGIN);
}

async function crawlValvrareDirectory() {
  const cached = getCachedValvrareDirectory();
  if (cached) return cached;

  const firstPageUrl = buildValvrareDirectoryPageUrl(1);
  const firstPage = await fetchHtmlPage(firstPageUrl);
  const firstPagePath = new URL(firstPage.url).pathname;

  if (!isValvrareOrigin(getOrigin(firstPage.url)) || !isValvrareDirectoryPath(firstPagePath)) {
    throw new Error('Không thể mở danh mục truyện Valvrare.');
  }

  const directoryItems = [...extractValvrareDirectoryItems(firstPage.html, firstPage.url)];
  const directoryMeta = extractValvrareDirectoryMeta(firstPage.html);

  for (let pageNumber = 2; pageNumber <= directoryMeta.totalPages; pageNumber += 1) {
    const page = await fetchHtmlPage(buildValvrareDirectoryPageUrl(pageNumber));
    directoryItems.push(...extractValvrareDirectoryItems(page.html, page.url));
  }

  const items = aggregateNovelItems(directoryItems)
    .sort((left, right) => left.firstIndex - right.firstIndex);

  if (items.length === 0) {
    throw new Error('Không tìm thấy truyện nào trong danh mục Valvrare.');
  }

  valvrareDirectoryCache = {
    items,
    sourceUrl: firstPageUrl,
    totalPages: directoryMeta.totalPages,
    totalItems: directoryMeta.totalItems || items.length,
    timestamp: Date.now()
  };

  return valvrareDirectoryCache;
}

function scoreNovelMatch(title, query) {
  const normalizedTitle = normalizeSearchText(title);
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 0;

  const tokens = normalizedQuery.split(' ').filter(token => token.length > 1);
  let score = 0;

  if (normalizedTitle === normalizedQuery) score += 120;
  if (normalizedTitle.startsWith(normalizedQuery)) score += 60;
  if (normalizedTitle.includes(normalizedQuery)) score += 50;

  let matchedTokenCount = 0;
  for (const token of tokens) {
    if (normalizedTitle.includes(token)) {
      matchedTokenCount += 1;
      score += 14;
    }
  }

  if (tokens.length > 0 && matchedTokenCount === tokens.length) score += 35;
  if (matchedTokenCount === 0 && !normalizedTitle.includes(normalizedQuery)) score -= 50;

  return score;
}

function buildCandidateUrls(pathOrUrl) {
  if (/^https?:\/\//i.test(pathOrUrl)) {
    return [pathOrUrl];
  }

  const uniqueOrigins = [activeOrigin, ...SITE_ORIGINS.filter(origin => origin !== activeOrigin)];
  return uniqueOrigins.map(origin => normalizeUrl(pathOrUrl, origin)).filter(Boolean);
}

async function fetchHtmlPage(pathOrUrl) {
  const candidates = buildCandidateUrls(pathOrUrl);
  let lastError = null;

  for (const candidateUrl of candidates) {
    try {
      const response = await httpClient.get(candidateUrl, {
        responseType: 'text',
        headers: buildRequestHeaders(candidateUrl)
      });
      const html = typeof response.data === 'string' ? response.data : String(response.data);
      const finalUrl = getFinalResponseUrl(response, candidateUrl);
      const finalOrigin = getOrigin(finalUrl);
      if (isSiteOrigin(finalOrigin)) {
        activeOrigin = finalOrigin;
      }
      return {
        url: finalUrl,
        html
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Khong the tai trang: ${pathOrUrl}`);
}

async function fetchBinary(pathOrUrl) {
  const candidates = buildCandidateUrls(pathOrUrl);
  let lastError = null;

  for (const candidateUrl of candidates) {
    try {
      const response = await httpClient.get(candidateUrl, {
        responseType: 'arraybuffer',
        headers: buildRequestHeaders(candidateUrl)
      });
      return Buffer.from(response.data);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Khong the tai file: ${pathOrUrl}`);
}

async function fetchHomepageRecommendations() {
  if (isValvrareOrigin(activeOrigin)) {
    const directory = await crawlValvrareDirectory();
    return directory.items;
  }

  const page = await fetchHtmlPage('/');
  const novels = extractNovelCandidatesFromHtml(page.html, page.url)
    .sort((left, right) => right.count - left.count || left.firstIndex - right.firstIndex)
    .slice(0, 40);

  if (novels.length === 0) {
    throw new Error('Khong tim thay truyen nao tren trang chu.');
  }

  return novels;
}

async function searchNovels(keyword) {
  if (isValvrareOrigin(activeOrigin)) {
    const directory = await crawlValvrareDirectory();

    return directory.items
      .map(item => ({ ...item, score: scoreNovelMatch(item.title, keyword) }))
      .filter(item => item.score > 0)
      .sort((left, right) => right.score - left.score || left.firstIndex - right.firstIndex)
      .slice(0, 30);
  }

  const encodedKeyword = encodeURIComponent(keyword);
  const searchPaths = [
    `/tim-kiem-nang-cao?author=&illustrator=&page=1&rejectgenres=&selectgenres=&status=0&title=${encodedKeyword}`,
    `/tim-kiem-nang-cao?page=1&title=${encodedKeyword}`,
    `/tim-kiem?keywords=${encodedKeyword}&page=1&query=${encodedKeyword}`
  ];

  for (const searchPath of searchPaths) {
    try {
      const page = await fetchHtmlPage(searchPath);
      const results = extractNovelCandidatesFromHtml(page.html, page.url)
        .map(item => ({ ...item, score: scoreNovelMatch(item.title, keyword) }))
        .filter(item => item.score > 0)
        .sort((left, right) => right.score - left.score || left.firstIndex - right.firstIndex)
        .slice(0, 30);

      if (results.length > 0) return results;
    } catch {
      // Try the next candidate endpoint.
    }
  }

  return [];
}

function extractSummary($) {
  const selectors = [
    '.rd-description-content',
    '.summary-content',
    '.series-summary',
    '.summary',
    '[itemprop="description"]',
    '#summary'
  ];

  for (const selector of selectors) {
    const text = normalizeWhitespace($(selector).first().text());
    if (text) return text;
  }

  let fallbackSummary = '';
  $('h1,h2,h3,h4,strong,b').each((_, element) => {
    if (fallbackSummary) return;
    const label = normalizeSearchText($(element).text());
    if (!label.includes('tom tat')) return;

    const nextText = normalizeWhitespace($(element).parent().next().text()) || normalizeWhitespace($(element).next().text());
    if (nextText) fallbackSummary = nextText;
  });

  return fallbackSummary;
}

function extractAuthor($) {
  let author = '';

  $('.series-information .info-item').each((_, element) => {
    if (author) return;
    const label = normalizeSearchText($(element).text());
    if (!label.includes('tac gia')) return;

    author = normalizeWhitespace(
      $(element).find('.info-value a').first().text() ||
      $(element).find('.info-value').first().text()
    );
  });

  if (!author) {
    author = normalizeWhitespace($('a[href*="/tac-gia/"]').first().text());
  }

  if (!author) {
    author = normalizeWhitespace($('.rd-author-name').first().text());
  }

  if (!author) {
    author = normalizeWhitespace($('meta[name="author"]').attr('content'));
  }

  return author || 'Khuyet danh';
}

function extractCoverUrl($, pageUrl) {
  const rawCoverStyle = $('.series-cover .img-in-ratio').first().attr('style') || '';
  const coverFromStyle = rawCoverStyle.match(/url\(['"]?(.*?)['"]?\)/)?.[1] || '';
  const coverFromImage = $('.series-cover img').first().attr('src')
    || $('.rd-cover-image').first().attr('src')
    || $('meta[property="og:image"]').attr('content')
    || '';

  return normalizeUrl(coverFromStyle || coverFromImage, pageUrl);
}

function extractValvrareVolumes($, pageUrl) {
  const moduleTitles = $('.modules-list .module-container .module-title')
    .map((_, element) => normalizeWhitespace($(element).text()))
    .get()
    .filter(Boolean);
  const moduleSections = $('.module-chapters').toArray();

  if (moduleTitles.length === 0 || moduleSections.length === 0) return [];

  const volumes = [];
  const totalSections = Math.min(moduleTitles.length, moduleSections.length);

  for (let index = 0; index < totalSections; index += 1) {
    const title = moduleTitles[index] || `Tap ${index + 1}`;
    const section = moduleSections[index];
    const chapters = [];

    $(section).find('.module-chapter-item').each((__, chapterItem) => {
      const anchor = $(chapterItem).find('a.chapter-title-link[href]').first();
      const href = anchor.attr('href');
      const chapterUrl = normalizeUrl(href, pageUrl);
      const chapterTitle = normalizeWhitespace(anchor.text());

      if (!chapterUrl || !chapterTitle) return;
      chapters.push({
        title: chapterTitle,
        url: chapterUrl
      });
    });

    if (chapters.length > 0) {
      volumes.push({ title, chapters });
    }
  }

  return volumes;
}

function extractVolumes($, pageUrl) {
  const volumes = [];

  $('.volume-list').each((_, element) => {
    const title = normalizeWhitespace($(element).find('.sect-title').first().text()) || `Tap ${volumes.length + 1}`;
    const chapters = [];

    $(element).find('.list-chapters li').each((__, listItem) => {
      const anchor = $(listItem).find('.chapter-name a').first();
      const href = anchor.attr('href');
      const chapterUrl = normalizeUrl(href, pageUrl);
      const chapterTitle = normalizeWhitespace(anchor.text());

      if (!chapterUrl || !chapterTitle) return;
      chapters.push({
        title: chapterTitle,
        url: chapterUrl
      });
    });

    if (chapters.length > 0) {
      volumes.push({ title, chapters });
    }
  });

  if (volumes.length > 0) return volumes;

  const valvrareVolumes = extractValvrareVolumes($, pageUrl);
  if (valvrareVolumes.length > 0) return valvrareVolumes;

  const fallbackChapters = [];
  $('.list-chapters li').each((_, listItem) => {
    const anchor = $(listItem).find('.chapter-name a').first();
    const href = anchor.attr('href');
    const chapterUrl = normalizeUrl(href, pageUrl);
    const chapterTitle = normalizeWhitespace(anchor.text());

    if (!chapterUrl || !chapterTitle) return;
    fallbackChapters.push({
      title: chapterTitle,
      url: chapterUrl
    });
  });

  if (fallbackChapters.length > 0) {
    volumes.push({
      title: 'Toan bo',
      chapters: fallbackChapters
    });
  }

  return volumes;
}

function extractNovelTitle($) {
  const valvrareTitleNode = $('.rd-novel-title').first().clone();
  if (valvrareTitleNode.length > 0) {
    valvrareTitleNode.find('button, span').remove();
  }

  return normalizeWhitespace($('.series-name a').first().text())
    || normalizeWhitespace(valvrareTitleNode.text())
    || normalizeWhitespace($('h1').first().text())
    || normalizeWhitespace($('meta[property="og:title"]').attr('content') || '')
    || normalizeWhitespace($('title').text())
    || 'Chua ro tieu de';
}

async function fetchNovelInfo(url) {
  const page = await fetchHtmlPage(url);
  const $ = cheerio.load(page.html);

  let title = normalizeWhitespace($('.series-name a').first().text())
    || normalizeWhitespace($('h1').first().text())
    || normalizeWhitespace($('title').text().replace(/\s*-\s*Cổng Light Novel.*$/i, ''))
    || 'Chua ro tieu de';

  title = extractNovelTitle($);
  const volumes = extractVolumes($, page.url);
  if (volumes.length === 0) {
    throw new Error('Khong doc duoc danh sach tap/chuong cua truyen nay.');
  }

  return {
    title,
    author: extractAuthor($),
    summary: extractSummary($),
    coverUrl: extractCoverUrl($, page.url),
    volumes,
    sourceUrl: page.url
  };
}

function decodeProtected(dataC, dataK, dataS) {
  let entries = [];

  try {
    entries = JSON.parse(dataC);
  } catch {
    return '';
  }

  if (!Array.isArray(entries) || entries.length === 0) return '';

  entries.sort((left, right) => parseInt(left.substring(0, 4), 10) - parseInt(right.substring(0, 4), 10));

  let result = '';

  for (const item of entries) {
    const payload = item.substring(4);

    if (dataS === 'xor_shuffle') {
      const buffer = Buffer.from(payload, 'base64');
      const decoded = Buffer.alloc(buffer.length);
      for (let index = 0; index < buffer.length; index += 1) {
        decoded[index] = buffer[index] ^ dataK.charCodeAt(index % dataK.length);
      }
      result += decoded.toString('utf-8');
      continue;
    }

    if (dataS === 'base64_reverse') {
      result += Buffer.from(payload.split('').reverse().join(''), 'base64').toString('utf-8');
      continue;
    }

    result += Buffer.from(payload, 'base64').toString('utf-8');
  }

  return result;
}

function getChapterContentRoot($) {
  const selectors = [
    '#chapter-content',
    '.chapter-content'
  ];

  for (const selector of selectors) {
    const root = $(selector).first();
    if (root.length > 0) return root;
  }

  return null;
}

function guessImageExtension(buffer) {
  if (!buffer || buffer.length < 4) return '.jpg';
  const hex = buffer.slice(0, 4).toString('hex');
  if (hex.startsWith('89504e47')) return '.png';
  if (hex.startsWith('ffd8ff')) return '.jpg';
  if (hex.startsWith('47494638')) return '.gif';
  if (hex.startsWith('52494646')) return '.webp';
  return '.jpg';
}

const BANNER_IMAGE_CLASS_TOKENS = new Set(['d-none', 'd-md-none', 'd-md-block']);

function isBannerImage(classAttr) {
  if (!classAttr) return false;
  return classAttr.split(/\s+/).some(function (token) { return BANNER_IMAGE_CLASS_TOKENS.has(token); });
}

async function downloadImageToFile(imageUrl, destPath) {
  try {
    const response = await httpClient.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: buildRequestHeaders(imageUrl)
    });
    const buffer = Buffer.from(response.data);
    if (buffer.length < 100) return null;
    const ext = guessImageExtension(buffer);
    const finalPath = destPath + ext;
    await fs.writeFile(finalPath, buffer);
    return finalPath;
  } catch {
    return null;
  }
}

async function embedImagesInHtml(contentHtml, pageUrl, tempDir) {
  const $doc = cheerio.load(contentHtml, null, false);

  $doc('img').each(function (_, img) {
    if (isBannerImage($doc(img).attr('class'))) {
      $doc(img).remove();
    }
  });

  const images = $doc('img').toArray();
  let embedded = 0;
  let failed = 0;

  await fs.ensureDir(tempDir);

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const src = $doc(img).attr('src') || $doc(img).attr('data-src') || '';
    const imageUrl = normalizeUrl(src, pageUrl);
    if (!imageUrl || imageUrl.startsWith('data:') || imageUrl.startsWith('file:')) continue;

    const baseName = 'img_' + Date.now() + '_' + i;
    const savedPath = await downloadImageToFile(imageUrl, path.join(tempDir, baseName));
    if (savedPath) {
      const fileUrl = 'file:///' + savedPath.replace(/\\/g, '/');
      $doc(img).attr('src', fileUrl);
      $doc(img).removeAttr('data-src');
      embedded += 1;
    } else {
      failed += 1;
    }
  }

  if (embedded > 0 || failed > 0) {
    process.stdout.write(' [' + embedded + ' ảnh');
    if (failed > 0) process.stdout.write(', lỗi ' + failed);
    process.stdout.write(']');
  }

  return $doc.html();
}

async function cleanupTempImages(tempDir) {
  try { await fs.remove(tempDir); } catch { /* ignore */ }
}

function buildChapterTextContent($, contentRoot, volumeTitle, chapterTitle, pageUrl) {
  let textContent = `${volumeTitle}\n\n${chapterTitle}\n\n`;
  const blocks = contentRoot.children().length > 0 ? contentRoot.children() : contentRoot.contents();

  blocks.each((_, element) => {
    const node = $(element);
    const images = node.is('img') ? node : node.find('img');

    images.each((__, image) => {
      const imageUrl = normalizeUrl($(image).attr('src') || $(image).attr('data-src'), pageUrl);
      if (imageUrl) {
        textContent += `[Anh: ${imageUrl}]\n\n`;
      }
    });

    const line = normalizeWhitespace(node.text());
    if (line) {
      textContent += `${line}\n\n`;
    }
  });

  return textContent;
}

async function generateEpub(epubPath, title, author, coverUrl, chapters) {
  const options = {
    title,
    author,
    publisher: 'Hako Downloader',
    tocTitle: 'Muc luc',
    ignoreFailedDownloads: true
  };

  if (coverUrl) options.cover = coverUrl;

  try {
    const buffer = await EpubGen(options, chapters);
    await fs.writeFile(epubPath, buffer);
    console.log(`[EPUB] ${epubPath}`);
  } catch (error) {
    console.log(`[CANH BAO] Loi anh bia: ${error.message}. Thu lai khong kem anh...`);

    for (const chapter of chapters) {
      const $chapter = cheerio.load(chapter.content);
      $chapter('img').remove();
      chapter.content = $chapter.html();
    }

    delete options.cover;
    const buffer = await EpubGen(options, chapters);
    await fs.writeFile(epubPath, buffer);
    console.log(`[EPUB] ${epubPath} (khong kem anh)`);
  }
}

async function downloadChapters(volume, volumeDir, author) {
  const epubChapters = [];
  const tempDir = path.join(volumeDir, '_temp_epub_images');

  for (const [index, chapter] of volume.chapters.entries()) {
    const prefix = `[${index + 1}/${volume.chapters.length}]`;
    process.stdout.write(`${prefix} ${chapter.title} `);

    const safeChapterTitle = sanitizeFileName(chapter.title);
    const txtPath = path.join(volumeDir, `${safeChapterTitle}.txt`);
    const htmlPath = path.join(volumeDir, `${safeChapterTitle}.html`);

    let contentHtml = '';

    if (fs.existsSync(htmlPath) && fs.existsSync(txtPath)) {
      console.log('(cache)');
      contentHtml = await fs.readFile(htmlPath, 'utf-8');
    } else {
      try {
        const chapterResponse = await httpClient.get(chapter.url, {
          headers: buildRequestHeaders(chapter.url)
        });
        let $chapter = cheerio.load(chapterResponse.data);
        const protectedDiv = $chapter('#chapter-c-protected');

        if (protectedDiv.length > 0) {
          const dataC = protectedDiv.attr('data-c');
          const dataK = protectedDiv.attr('data-k') || '';
          const dataS = protectedDiv.attr('data-s') || 'none';

          if (dataC) {
            const decodedHtml = decodeProtected(dataC, dataK, dataS);
            if (decodedHtml) {
              protectedDiv.replaceWith(decodedHtml);
              $chapter = cheerio.load($chapter.html());
            }
          }
        }

        const contentRoot = getChapterContentRoot($chapter);
        contentHtml = contentRoot?.html() || '';
        if (!contentHtml) {
          console.log('(trong)');
          continue;
        }

        const textContent = buildChapterTextContent($chapter, contentRoot, volume.title, chapter.title, chapter.url);

        await fs.writeFile(txtPath, textContent, 'utf-8');
        await fs.writeFile(htmlPath, contentHtml, 'utf-8');
        console.log('OK');
      } catch (error) {
        console.log(`LOI: ${error.message}`);
        if (error.response && error.response.status === 429) {
          await delay(10000);
        }
        continue;
      }

      await delay(2000);
    }

    const epubContent = contentHtml
      ? await embedImagesInHtml(contentHtml, chapter.url, tempDir)
      : '';

    epubChapters.push({
      title: `${volume.title} - ${chapter.title}`,
      author,
      content: epubContent
    });
  }

  return { epubChapters, tempDir };
}

async function removeIfExists(targetPath) {
  if (await fs.pathExists(targetPath)) {
    await fs.remove(targetPath);
    return true;
  }

  return false;
}

async function cleanupLegacyEpubOutputs(novel, selectedVolumeIndexes, novelDir) {
  const safeTitle = sanitizeFileName(novel.title);
  const downloadsDir = path.join(__dirname, 'downloads');
  const legacyPaths = [
    path.join(downloadsDir, `${safeTitle}.epub`),
    ...selectedVolumeIndexes.map(volumeIndex => {
      const safeVolumeTitle = sanitizeFileName(novel.volumes[volumeIndex].title);
      return path.join(downloadsDir, `${safeTitle} - ${safeVolumeTitle}.epub`);
    })
  ].filter(filePath => path.dirname(filePath) !== novelDir);

  let removedCount = 0;

  for (const legacyPath of legacyPaths) {
    if (await removeIfExists(legacyPath)) {
      removedCount += 1;
    }
  }

  if (removedCount > 0) {
    console.log(`[Dọn dẹp] Đã xóa ${removedCount} file EPUB cũ ở thư mục gốc.`);
  }
}

async function cleanupIntermediateChapterFiles(volumeDirs) {
  let removedCount = 0;
  let removedVolumeDirs = 0;

  for (const volumeDir of volumeDirs) {
    if (!await fs.pathExists(volumeDir)) continue;

    const entries = await fs.readdir(volumeDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.txt') && !entry.name.endsWith('.html')) continue;

      await fs.remove(path.join(volumeDir, entry.name));
      removedCount += 1;
    }

    const remainingEntries = await fs.readdir(volumeDir);
    if (remainingEntries.length === 0) {
      await fs.remove(volumeDir);
      removedVolumeDirs += 1;
    }
  }

  if (removedCount > 0) {
    console.log(`[Dọn dẹp] Đã xóa ${removedCount} file TXT/HTML trung gian.`);
  }

  if (removedVolumeDirs > 0) {
    console.log(`[Dọn dẹp] Đã xóa ${removedVolumeDirs} thư mục tập trống.`);
  }
}

function enableInteractiveMode() {
  term.grabInput({ mouse: 'button' });
  term.hideCursor();
}

function disableInteractiveMode() {
  term.hideCursor(false);
  term.grabInput(false);
}

function cleanupTerminal() {
  disableInteractiveMode();
  term.styleReset();
}

function renderHeader(title, subtitle = '') {
  term.clear();
  term.bold.cyan('HAKO DOWNLOADER CLI\n');
  term.dim(`${getStatusLine()}\n`);
  if (title) term.bold.white(`${title}\n`);
  if (subtitle) term.gray(`${subtitle}\n`);
  term('\n');
}

async function waitForKey(message = 'Nhan phim bat ky de tiep tuc...') {
  term.dim(`\n${message}`);
  await new Promise(resolve => term.once('key', resolve));
}

async function promptText(title, prompt, options = {}) {
  if (!options.inline) {
    renderHeader(title, options.subtitle || '');
  }
  term.white(`${prompt} `);

  const controller = term.inputField({
    cancelable: true,
    default: options.default || '',
    history: options.history || []
  });

  const value = await controller.promise;
  term('\n');
  return normalizeWhitespace(value);
}

function createMenuItems(items, labelSelector) {
  return items.map((item, index) => {
    const label = typeof labelSelector === 'function' ? labelSelector(item, index) : String(item);
    return truncate(label, Math.max(20, term.width - 8));
  });
}

async function chooseFromMenu(title, subtitle, items, options = {}) {
  if (!options.inline) {
    renderHeader(title, subtitle);
  }

  const labels = createMenuItems(items, options.labelSelector);
  const menuController = term.singleColumnMenu(labels, {
    cancelable: true,
    oneLineItem: true,
    selectedIndex: options.selectedIndex || 0,
    selectedStyle: term.black.bgCyan,
    selectedLeftPadding: ' > ',
    leftPadding: '   ',
    itemMaxWidth: Math.max(24, term.width - 4)
  });

  const response = await menuController.promise;
  if (!response || response.canceled) return null;
  return items[response.selectedIndex];
}

async function showLoadingScreen(title, message) {
  renderHeader(title, message);
  await delay(80);
}

async function showErrorScreen(title, error) {
  renderHeader(title, 'Co loi xay ra');
  term.red(`${formatErrorMessage(error)}\n`);
  await waitForKey();
}

async function getTerminalImage() {
  if (!terminalImageModulePromise) {
    terminalImageModulePromise = import('terminal-image').then(module => module.default || module);
  }

  return terminalImageModulePromise;
}

async function getTerminalGraphicsSupport() {
  if (!terminalGraphicsSupportPromise) {
    terminalGraphicsSupportPromise = import('supports-terminal-graphics')
      .then(module => (module.default || module).stdout || { kitty: false, iterm2: false, sixel: false })
      .catch(() => ({ kitty: false, iterm2: false, sixel: false }));
  }

  return terminalGraphicsSupportPromise;
}

async function renderCoverImage(coverUrl, options = {}) {
  if (!coverUrl) return;

  try {
    const imageBuffer = await fetchBinary(coverUrl);
    const terminalImage = await getTerminalImage();
    const graphicsSupport = await getTerminalGraphicsSupport();
    const hasNativeSupport = Boolean(graphicsSupport.kitty || graphicsSupport.iterm2 || graphicsSupport.sixel);
    const mode = options.mode || 'preview';
    const width = mode === 'full'
      ? (hasNativeSupport ? '55%' : '85%')
      : (hasNativeSupport ? '35%' : '55%');
    const preview = await terminalImage.buffer(imageBuffer, {
      width,
      preserveAspectRatio: true,
      preferNativeRender: true
    });

    if (!hasNativeSupport) {
      term.dim('[Terminal hien tai khong ho tro anh native, nen preview duoi day la dang block mau.]\n');
    }

    term(`${preview}\n`);
  } catch {
    term.dim('[Khong render duoc anh bia trong terminal]\n');
  }
}

function renderVolumePreview(volumes) {
  term.bold('Danh sach tap:\n');
  const previewVolumes = volumes.slice(0, 12);

  previewVolumes.forEach((volume, index) => {
    term(` ${index + 1}. ${volume.title} (${volume.chapters.length} chuong)\n`);
  });

  if (volumes.length > previewVolumes.length) {
    term.dim(` ... va con ${volumes.length - previewVolumes.length} tap nua\n`);
  }
}

async function chooseEpubMode() {
  const selected = await chooseFromMenu(
    'Che do EPUB',
    'Ban co the click chuot de chon',
    EPUB_MODES,
    { labelSelector: item => item.label }
  );

  return selected ? selected.id : null;
}

async function chooseVolumeIndexes(novel) {
  const mode = await chooseFromMenu(
    'Chon pham vi tai',
    'Tai tat ca hoac nhap so tap can tai',
    [
      { id: 'all', label: 'Tai tat ca tap' },
      { id: 'custom', label: 'Tu nhap so tap (vi du: 1,3,5)' },
      { id: 'back', label: 'Quay lai' }
    ],
    { labelSelector: item => item.label }
  );

  if (!mode || mode.id === 'back') return null;
  if (mode.id === 'all') return novel.volumes.map((_, index) => index);

  renderHeader('Nhap tap can tai', 'Nhap 0 de tai tat ca, hoac 1,3,5 de chon nhieu tap');
  renderVolumePreview(novel.volumes);
  term('\n');

  const raw = await promptText('Nhap tap can tai', 'Lua chon:', {
    subtitle: 'Nhap 0 de tai tat ca, hoac 1,3,5 de chon nhieu tap',
    inline: true
  });

  if (!raw) return null;
  if (raw === '0') return novel.volumes.map((_, index) => index);

  const indexes = raw
    .split(',')
    .map(part => parseInt(part.trim(), 10) - 1)
    .filter(index => Number.isInteger(index) && index >= 0 && index < novel.volumes.length);

  return indexes.length > 0 ? [...new Set(indexes)] : null;
}

async function runDownloadFlow(novel, selectedVolumeIndexes, epubMode) {
  disableInteractiveMode();
  console.clear();
  console.log('=== BAT DAU TAI ===');
  console.log(`Truyen: ${novel.title}`);
  console.log(`Tac gia: ${novel.author}`);
  console.log(`Nguon: ${novel.sourceUrl}`);
  console.log('');

  const safeTitle = sanitizeFileName(novel.title);
  const novelDir = path.join(__dirname, 'downloads', safeTitle);
  await fs.ensureDir(novelDir);

  const allEpubChapters = [];
  const perVolumeChapters = {};
  const volumeDirs = [];
  const tempImageDirs = [];

  for (const volumeIndex of selectedVolumeIndexes) {
    const volume = novel.volumes[volumeIndex];
    const safeVolumeTitle = sanitizeFileName(volume.title);
    const volumeDir = path.join(novelDir, safeVolumeTitle);
    await fs.ensureDir(volumeDir);
    volumeDirs.push(volumeDir);

    console.log(`\n--- ${volume.title} ---`);
    const { epubChapters: chapters, tempDir } = await downloadChapters(volume, volumeDir, novel.author);
    allEpubChapters.push(...chapters);
    perVolumeChapters[volumeIndex] = {
      safeVolumeTitle,
      chapters
    };
    tempImageDirs.push(tempDir);
  }

  if (epubMode !== '0') {
    await cleanupLegacyEpubOutputs(novel, selectedVolumeIndexes, novelDir);
  }

  if (epubMode === '1' || epubMode === '3') {
    const epubPath = path.join(novelDir, `${safeTitle}.epub`);
    await generateEpub(epubPath, novel.title, novel.author, novel.coverUrl, [...allEpubChapters]);
  }

  if (epubMode === '2' || epubMode === '3') {
    for (const volumeIndex of selectedVolumeIndexes) {
      const record = perVolumeChapters[volumeIndex];
      if (!record || record.chapters.length === 0) continue;

      const epubPath = path.join(novelDir, `${record.safeVolumeTitle}.epub`);
      await generateEpub(
        epubPath,
        `${novel.title} - ${novel.volumes[volumeIndex].title}`,
        novel.author,
        novel.coverUrl,
        [...record.chapters]
      );
    }
  }

  // Clean up temp image files after EPUB generation
  for (const dir of tempImageDirs) {
    await cleanupTempImages(dir);
  }

  if (epubMode === '3') {
    await cleanupIntermediateChapterFiles(volumeDirs);
  }

  console.log('\n=== HOAN TAT ===');
  console.log(`TXT: ${novelDir}`);
  if (epubMode !== '0') {
    console.log(`EPUB: ${novelDir}`);
  }

  console.log('');
  console.log('Nhan Enter de quay lai...');
  process.stdin.resume();
  await new Promise(resolve => process.stdin.once('data', resolve));
  enableInteractiveMode();
}

async function showNovelDetailScreen(novel) {
  renderHeader('Chi tiet truyen', 'Click vao hanh dong muon thuc hien');

  await renderCoverImage(novel.coverUrl, { mode: 'preview' });

  term.bold.white(`${novel.title}\n`);
  term(`Tac gia: ${novel.author}\n`);
  term(`So tap: ${novel.volumes.length}\n`);
  term(`Nguon: ${novel.sourceUrl}\n\n`);

  if (novel.summary) {
    term(`${truncate(novel.summary, Math.max(120, term.width * 3))}\n\n`);
  }

  renderVolumePreview(novel.volumes);
  term('\n');

  const action = await chooseFromMenu(
    'Chi tiet truyen',
    'Ban co the tai ngay, chon tap, hoac quay lai',
    [
      { id: 'download_all', label: 'Tai tat ca tap' },
      { id: 'choose_volumes', label: 'Chon tap can tai' },
      { id: 'show_cover', label: 'Xem lai anh bia' },
      { id: 'back', label: 'Quay lai' }
    ],
    { labelSelector: item => item.label, inline: true }
  );

  if (!action || action.id === 'back') return;

  if (action.id === 'show_cover') {
    renderHeader('Anh bia', novel.title);
    await renderCoverImage(novel.coverUrl, { mode: 'full' });
    await waitForKey();
    await showNovelDetailScreen(novel);
    return;
  }

  const epubMode = await chooseEpubMode();
  if (!epubMode) {
    await showNovelDetailScreen(novel);
    return;
  }

  const selectedVolumeIndexes = action.id === 'download_all'
    ? novel.volumes.map((_, index) => index)
    : await chooseVolumeIndexes(novel);

  if (!selectedVolumeIndexes || selectedVolumeIndexes.length === 0) {
    renderHeader('Khong co tap nao duoc chon', 'Quay lai man hinh chi tiet');
    term.yellow('Ban chua chon tap hop le.\n');
    await waitForKey();
    await showNovelDetailScreen(novel);
    return;
  }

  await runDownloadFlow(novel, selectedVolumeIndexes, epubMode);
}

async function selectNovelFromList(title, subtitle, novels) {
  const items = novels.map((novel, index) => ({
    ...novel,
    displayLabel: `${index + 1}. ${novel.title}`
  }));

  const choice = await chooseFromMenu(title, subtitle, items, {
    labelSelector: item => item.displayLabel
  });

  return choice || null;
}

async function searchFlow() {
  const keyword = await promptText('Tim truyen', 'Nhap tu khoa:');
  if (!keyword) return;

  await showLoadingScreen('Tim truyen', `Dang tim theo tu khoa: ${keyword}`);

  const results = await searchNovels(keyword);
  if (!results || results.length === 0) {
    renderHeader('Tim truyen', 'Khong co ket qua phu hop');
    term.yellow(`Khong tim thay truyen nao khop voi "${keyword}".\n`);
    await waitForKey();
    return;
  }

  const selectedNovel = await selectNovelFromList(
    'Ket qua tim kiem',
    'Click vao truyen muon xem',
    results
  );

  if (!selectedNovel) return;

  await showLoadingScreen('Dang lay thong tin truyen', selectedNovel.title);
  const novel = await fetchNovelInfo(selectedNovel.url);
  await showNovelDetailScreen(novel);
}

async function homepageFlow() {
  const isValvrareMode = isValvrareOrigin(activeOrigin);
  const loadingTitle = isValvrareMode ? 'Danh mục Valvrare' : 'Gợi ý từ trang chủ';
  const loadingSubtitle = isValvrareMode
    ? 'Đang crawl toàn bộ thư viện Valvrare...'
    : 'Đang crawl danh sách để bạn chọn...';

  await showLoadingScreen(loadingTitle, loadingSubtitle);
  const novels = await fetchHomepageRecommendations();
  const directory = isValvrareMode ? getCachedValvrareDirectory() : null;

  const selectedNovel = await selectNovelFromList(
    loadingTitle,
    isValvrareMode
      ? `Đã gom ${directory?.totalItems || novels.length} truyện từ ${directory?.totalPages || 1} trang danh mục`
      : 'Danh sach nay duoc gom tu nhung truyen dang xuat hien tren trang chu',
    novels
  );

  if (!selectedNovel) return;

  await showLoadingScreen('Dang lay thong tin truyen', selectedNovel.title);
  const novel = await fetchNovelInfo(selectedNovel.url);
  await showNovelDetailScreen(novel);
}

async function directUrlFlow() {
  const url = await promptText('Nhap URL', 'Link truyện hoặc danh mục:');
  if (!url) return;

  if (isValvrareDirectoryUrl(url)) {
    await showLoadingScreen('Danh mục Valvrare', url);
    const directory = await crawlValvrareDirectory();

    const selectedNovel = await selectNovelFromList(
      'Danh mục Valvrare',
      `Đã gom ${directory.totalItems} truyện từ ${directory.totalPages} trang danh mục`,
      directory.items
    );

    if (!selectedNovel) return;

    await showLoadingScreen('Dang lay thong tin truyen', selectedNovel.title);
    const novel = await fetchNovelInfo(selectedNovel.url);
    await showNovelDetailScreen(novel);
    return;
  }

  await showLoadingScreen('Dang lay thong tin truyen', url);
  const novel = await fetchNovelInfo(url);
  await showNovelDetailScreen(novel);
}

async function configureDnsFlow() {
  const choice = await chooseFromMenu(
    'Cau hinh DNS',
    'Ap dung cho phien chay hien tai cua app',
    [
      DNS_PROFILES.system,
      DNS_PROFILES.cloudflare,
      DNS_PROFILES.google,
      { id: 'custom', label: 'Tu nhap DNS (vi du: 1.1.1.1, 8.8.8.8)' },
      { id: 'back', label: 'Quay lai' }
    ],
    { labelSelector: item => item.label }
  );

  if (!choice || choice.id === 'back') return;

  if (choice.id !== 'custom') {
    applyDnsProfile(choice);
    renderHeader('Cau hinh DNS', 'Da cap nhat cau hinh');
    term.green(`Dang dung: ${getDnsStatusLabel()}\n`);
    await waitForKey();
    return;
  }

  const rawServers = await promptText(
    'Tu nhap DNS',
    'Nhap DNS cach nhau boi dau phay:',
    { subtitle: 'Vi du: 1.1.1.1, 1.0.0.1' }
  );

  if (!rawServers) return;

  const servers = rawServers.split(',').map(item => item.trim()).filter(Boolean);
  const invalidServers = servers.filter(server => net.isIP(server) === 0);

  if (servers.length === 0 || invalidServers.length > 0) {
    renderHeader('Tu nhap DNS', 'Gia tri khong hop le');
    term.red(`DNS loi: ${invalidServers.join(', ') || 'trong'}\n`);
    await waitForKey();
    return;
  }

  applyDnsProfile(createDnsProfile(`Tu nhap (${servers.join(', ')})`, servers));
  renderHeader('Cau hinh DNS', 'Da cap nhat cau hinh');
  term.green(`Dang dung: ${getDnsStatusLabel()}\n`);
  await waitForKey();
}

async function mainMenuLoop() {
  while (true) {
    const action = await chooseFromMenu(
      'Menu chinh',
      'Click chuot de chon, khong can dung phim mui ten',
      [
        { id: 'homepage', label: 'Goi y tu trang chu' },
        { id: 'search', label: 'Tim truyen theo tu khoa' },
        { id: 'url', label: 'Nhap URL truyen truc tiep' },
        { id: 'dns', label: 'Cau hinh DNS' },
        { id: 'exit', label: 'Thoat' }
      ],
      { labelSelector: item => item.label }
    );

    if (!action || action.id === 'exit') return;

    try {
      if (action.id === 'homepage') await homepageFlow();
      if (action.id === 'search') await searchFlow();
      if (action.id === 'url') await directUrlFlow();
      if (action.id === 'dns') await configureDnsFlow();
    } catch (error) {
      await showErrorScreen('Co loi xay ra', error);
    }
  }
}

async function main() {
  enableInteractiveMode();

  process.on('SIGINT', () => {
    cleanupTerminal();
    process.exit(0);
  });

  try {
    await mainMenuLoop();
  } finally {
    cleanupTerminal();
    term('\nTam biet!\n');
  }
}

main().catch(error => {
  cleanupTerminal();
  console.error(error);
  process.exit(1);
});
