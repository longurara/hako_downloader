const axios = require('axios');
const cheerio = require('cheerio');
const dns = require('dns');
const express = require('express');
const fs = require('fs-extra');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const EpubGen = require('epub-gen-memory').default;

const app = express();
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
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
  system: { id: 'system', label: 'Hệ thống mặc định', servers: null },
  cloudflare: { id: 'cloudflare', label: 'Cloudflare (1.1.1.1, 1.0.0.1)', servers: ['1.1.1.1', '1.0.0.1'] },
  google: { id: 'google', label: 'Google (8.8.8.8, 8.8.4.4)', servers: ['8.8.8.8', '8.8.4.4'] }
};

const EPUB_MODES = ['0', '1', '2', '3'];
const BATCH_CONCURRENCY_VALUES = [1, 2, 3];

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
let valvrareDirectoryCache = null;

const tasks = new Map();

applyDnsProfile(DNS_PROFILES.system);

app.use(express.json({ limit: '1mb' }));
app.use('/downloads', express.static(DOWNLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

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

function toDownloadUrl(filePath) {
  const relativePath = path.relative(DOWNLOADS_DIR, filePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }

  const encodedPath = relativePath
    .split(path.sep)
    .map(segment => encodeURIComponent(segment))
    .join('/');

  return `/downloads/${encodedPath}`;
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
  if (messages.length === 0) return 'Lỗi không xác định';
  if (messages.length === 1) return messages[0];
  return messages.slice(0, 5).join(' | ');
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

function getStatus() {
  return {
    site: activeOrigin,
    dns: dnsProfile.label
  };
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

    items.push({ title, imageUrl, url });
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

      return { url: finalUrl, html };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Không thể tải trang: ${pathOrUrl}`);
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
    throw new Error('Không tìm thấy truyện nào trên trang chủ.');
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
      // Try the next endpoint.
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
      volumes.push({ title, chapters, coverUrl: '' });
    }
  }

  return volumes;
}

function extractVolumes($, pageUrl) {
  const volumes = [];

  $('.volume-list').each((_, element) => {
    const title = normalizeWhitespace($(element).find('.sect-title').first().text()) || `Tap ${volumes.length + 1}`;
    const chapters = [];

    // Extract volume cover from volume-cover
    let coverUrl = '';
    const volumeCoverDiv = $(element).find('.volume-cover .content.img-in-ratio').first();
    if (volumeCoverDiv.length > 0) {
      const styleAttr = volumeCoverDiv.attr('style') || '';
      const urlMatch = styleAttr.match(/url\(['"]?(.*?)['"]?\)/);
      if (urlMatch && urlMatch[1]) {
        coverUrl = normalizeUrl(urlMatch[1], pageUrl);
      }
    }

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
      volumes.push({ title, chapters, coverUrl });
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
      chapters: fallbackChapters,
      coverUrl: ''
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
    || 'Chưa rõ tiêu đề';

  title = extractNovelTitle($);
  const volumes = extractVolumes($, page.url);
  if (volumes.length === 0) {
    throw new Error('Không đọc được danh sách tập/chương của truyện này.');
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


async function embedImagesInHtml(contentHtml, pageUrl, tempDir, handlers) {
  const $doc = cheerio.load(contentHtml, null, false);

  // Remove banner/responsive images
  $doc('img').each(function (_, img) {
    if (isBannerImage($doc(img).attr('class'))) {
      $doc(img).remove();
    }
  });

  const images = $doc('img').toArray();
  let embedded = 0;
  let failed = 0;
  const errors = [];

  await fs.ensureDir(tempDir);

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const src = $doc(img).attr('src') || $doc(img).attr('data-src') || '';
    const imageUrl = normalizeUrl(src, pageUrl);
    if (!imageUrl || imageUrl.startsWith('data:') || imageUrl.startsWith('file:')) continue;

    try {
      // Build headers for image request
      const imageHeaders = {
        ...buildRequestHeaders(imageUrl),
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site'
      };

      const response = await httpClient.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 20000,
        headers: imageHeaders,
        maxRedirects: 10
      });

      const buffer = Buffer.from(response.data);

      if (buffer.length < 100) {
        failed += 1;
        errors.push(`Ảnh ${i}: quá nhỏ (${buffer.length} bytes) - URL: ${imageUrl}`);
        continue;
      }

      // Detect image extension from buffer
      const ext = guessImageExtension(buffer);
      const fileName = `img_${Date.now()}_${i}${ext}`;
      const filePath = path.join(tempDir, fileName);

      // Save original image without any processing
      await fs.writeFile(filePath, buffer);

      // Verify file was written correctly
      const fileStats = await fs.stat(filePath);
      if (fileStats.size < 100) {
        failed += 1;
        errors.push(`Ảnh ${i}: file lưu bị lỗi (${fileStats.size} bytes)`);
        continue;
      }

      // Use file:// URL for epub-gen-memory to process
      const fileUrl = 'file://' + filePath.replace(/\\/g, '/');
      $doc(img).attr('src', fileUrl);
      $doc(img).removeAttr('data-src');
      // Add width constraint for better display on e-readers
      $doc(img).attr('style', 'max-width: 100%; height: auto;');
      embedded += 1;
    } catch (error) {
      failed += 1;
      const statusCode = error.response?.status || 'N/A';
      errors.push(`Ảnh ${i}: [${statusCode}] ${error.message} - URL: ${imageUrl}`);
    }
  }

  if (embedded > 0 || failed > 0) {
    if (handlers && handlers.onLog) {
      const msg = `[ảnh] Nhúng ${embedded} ảnh` + (failed > 0 ? `, lỗi ${failed}` : '');
      handlers.onLog(msg);

      // Log errors if any
      if (errors.length > 0 && errors.length <= 5) {
        errors.forEach(err => handlers.onLog(`  ${err}`));
      } else if (errors.length > 5) {
        errors.slice(0, 3).forEach(err => handlers.onLog(`  ${err}`));
        handlers.onLog(`  ... và ${errors.length - 3} lỗi khác`);
      }
    }
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

async function generateEpub(epubPath, title, author, coverUrl, chapters, tempDir) {
  const options = {
    title,
    author,
    publisher: 'Hako Downloader',
    tocTitle: 'Mục lục',
    ignoreFailedDownloads: true
  };

  if (coverUrl) options.cover = coverUrl;

  try {
    const buffer = await EpubGen(options, chapters);
    await fs.writeFile(epubPath, buffer);
  } catch (error) {
    // If EPUB generation fails, try without images
    for (const chapter of chapters) {
      const $chapter = cheerio.load(chapter.content);
      $chapter('img').remove();
      chapter.content = $chapter.html();
    }

    delete options.cover;
    const buffer = await EpubGen(options, chapters);
    await fs.writeFile(epubPath, buffer);
  }
}

async function downloadChapters(volume, volumeDir, author, handlers = {}) {
  const epubChapters = [];
  const tempDir = path.join(volumeDir, '_temp_epub_images');

  for (const [index, chapter] of volume.chapters.entries()) {
    handlers.onChapterStart?.(chapter, index, volume.chapters.length);

    const safeChapterTitle = sanitizeFileName(chapter.title);
    const txtPath = path.join(volumeDir, `${safeChapterTitle}.txt`);
    const htmlPath = path.join(volumeDir, `${safeChapterTitle}.html`);

    let contentHtml = '';

    if (fs.existsSync(htmlPath) && fs.existsSync(txtPath)) {
      contentHtml = await fs.readFile(htmlPath, 'utf-8');
      handlers.onLog?.(`[cache] ${chapter.title}`);
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
          handlers.onLog?.(`[bỏ qua] ${chapter.title} (rỗng)`);
          continue;
        }

        const textContent = buildChapterTextContent($chapter, contentRoot, volume.title, chapter.title, chapter.url);

        await fs.writeFile(txtPath, textContent, 'utf-8');
        await fs.writeFile(htmlPath, contentHtml, 'utf-8');
        handlers.onLog?.(`[ok] ${chapter.title}`);
      } catch (error) {
        handlers.onLog?.(`[lỗi] ${chapter.title}: ${error.message}`);
        if (error.response && error.response.status === 429) {
          await delay(10000);
        }
        continue;
      }

      await delay(2000);
    }

    const epubContent = contentHtml
      ? await embedImagesInHtml(contentHtml, chapter.url, tempDir, handlers)
      : '';

    epubChapters.push({
      title: `${volume.title} - ${chapter.title}`,
      author,
      content: epubContent
    });

    handlers.onChapterDone?.(chapter, index, volume.chapters.length);
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

async function cleanupLegacyEpubOutputs(novel, selectedVolumeIndexes, novelDir, handlers = {}) {
  const safeTitle = sanitizeFileName(novel.title);
  const legacyPaths = [
    path.join(DOWNLOADS_DIR, `${safeTitle}.epub`),
    ...selectedVolumeIndexes.map(volumeIndex => {
      const safeVolumeTitle = sanitizeFileName(novel.volumes[volumeIndex].title);
      return path.join(DOWNLOADS_DIR, `${safeTitle} - ${safeVolumeTitle}.epub`);
    })
  ].filter(filePath => path.dirname(filePath) !== novelDir);

  let removedCount = 0;

  for (const legacyPath of legacyPaths) {
    if (await removeIfExists(legacyPath)) {
      removedCount += 1;
    }
  }

  if (removedCount > 0) {
    handlers.onLog?.(`Đã dọn ${removedCount} file EPUB cũ ở thư mục gốc.`);
  }
}

async function cleanupIntermediateChapterFiles(volumeDirs, handlers = {}) {
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
    handlers.onLog?.(`Đã dọn ${removedCount} file TXT/HTML trung gian.`);
  }

  if (removedVolumeDirs > 0) {
    handlers.onLog?.(`Đã dọn ${removedVolumeDirs} thư mục tập trống.`);
  }
}

function getNovelOutputLayout(novel, selectedVolumeIndexesInput = []) {
  const selectedVolumeIndexes = resolveSelectedVolumeIndexes(novel.volumes, selectedVolumeIndexesInput);
  const safeTitle = sanitizeFileName(novel.title);
  const novelDir = path.join(DOWNLOADS_DIR, safeTitle);
  const singleEpubPath = path.join(novelDir, `${safeTitle}.epub`);
  const volumeOutputs = selectedVolumeIndexes.map(volumeIndex => {
    const volume = novel.volumes[volumeIndex];
    const safeVolumeTitle = sanitizeFileName(volume.title);

    return {
      volumeIndex,
      title: volume.title,
      safeVolumeTitle,
      volumeDir: path.join(novelDir, safeVolumeTitle),
      epubPath: path.join(novelDir, `${safeVolumeTitle}.epub`)
    };
  });

  return {
    selectedVolumeIndexes,
    safeTitle,
    novelDir,
    singleEpubPath,
    volumeOutputs
  };
}

async function volumeDirHasChapterFiles(volumeDir) {
  if (!await fs.pathExists(volumeDir)) {
    return false;
  }

  const entries = await fs.readdir(volumeDir, { withFileTypes: true });
  return entries.some(entry => {
    return entry.isFile() && (entry.name.endsWith('.txt') || entry.name.endsWith('.html'));
  });
}

async function detectExistingNovelOutputs(novel, selectedVolumeIndexesInput = []) {
  const layout = getNovelOutputLayout(novel, selectedVolumeIndexesInput);
  const hasNovelDir = await fs.pathExists(layout.novelDir);

  if (!hasNovelDir) {
    return {
      ...layout,
      isComplete: false,
      completedKinds: [],
      existingEpubFiles: []
    };
  }

  const completedKinds = [];
  const existingEpubFiles = [];

  const hasSingleEpub = await fs.pathExists(layout.singleEpubPath);
  if (hasSingleEpub) {
    completedKinds.push('EPUB tổng');
    existingEpubFiles.push(layout.singleEpubPath);
  }

  let hasAllVolumeEpubs = layout.volumeOutputs.length > 0;
  let hasAllChapterCaches = layout.volumeOutputs.length > 0;

  for (const record of layout.volumeOutputs) {
    const hasVolumeEpub = await fs.pathExists(record.epubPath);
    if (hasVolumeEpub) {
      existingEpubFiles.push(record.epubPath);
    } else {
      hasAllVolumeEpubs = false;
    }

    if (!await volumeDirHasChapterFiles(record.volumeDir)) {
      hasAllChapterCaches = false;
    }
  }

  if (hasAllVolumeEpubs) {
    completedKinds.push('EPUB theo tập');
  }

  if (hasAllChapterCaches) {
    completedKinds.push('TXT/HTML');
  }

  return {
    ...layout,
    isComplete: completedKinds.length > 0,
    completedKinds,
    existingEpubFiles: [...new Set(existingEpubFiles)]
  };
}

function hasRequestedNovelOutputs(existingOutput, epubModeInput) {
  const epubMode = ensureValidEpubMode(epubModeInput);

  if (epubMode === '0') {
    return existingOutput.completedKinds.includes('TXT/HTML');
  }

  if (epubMode === '1') {
    return existingOutput.completedKinds.includes('EPUB tổng');
  }

  if (epubMode === '2') {
    return existingOutput.completedKinds.includes('EPUB theo tập');
  }

  return existingOutput.completedKinds.includes('EPUB tổng')
    && existingOutput.completedKinds.includes('EPUB theo tập');
}

function createTask(payload) {
  const task = {
    id: crypto.randomUUID(),
    status: 'queued',
    progress: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logs: [],
    payload
  };

  tasks.set(task.id, task);
  return task;
}

function getTask(taskId) {
  return tasks.get(taskId);
}

function updateTask(taskId, patch) {
  const task = tasks.get(taskId);
  if (!task) return null;

  Object.assign(task, patch, { updatedAt: new Date().toISOString() });
  return task;
}

function pushTaskLog(taskId, message) {
  const task = tasks.get(taskId);
  if (!task) return;

  task.logs.push({
    at: new Date().toISOString(),
    message
  });

  if (task.logs.length > 200) {
    task.logs.splice(0, task.logs.length - 200);
  }

  task.updatedAt = new Date().toISOString();
  console.log(`[task:${taskId}] ${message}`);
}

function serializeTask(task) {
  if (!task) return null;

  return {
    id: task.id,
    status: task.status,
    progress: task.progress,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    error: task.error,
    result: task.result,
    payload: task.payload,
    logs: task.logs
  };
}

function ensureValidEpubMode(epubMode) {
  return EPUB_MODES.includes(epubMode) ? epubMode : '1';
}

function ensureBatchConcurrency(value) {
  const parsed = Number.parseInt(value, 10);
  return BATCH_CONCURRENCY_VALUES.includes(parsed) ? parsed : 2;
}

function resolveSelectedVolumeIndexes(volumes, selectedVolumeIndexes) {
  if (!Array.isArray(selectedVolumeIndexes) || selectedVolumeIndexes.length === 0) {
    return volumes.map((_, index) => index);
  }

  const indexes = selectedVolumeIndexes
    .map(value => Number.parseInt(value, 10))
    .filter(index => Number.isInteger(index) && index >= 0 && index < volumes.length);

  return [...new Set(indexes)];
}

async function downloadNovelAssets(novel, selectedVolumeIndexesInput, epubModeInput, customTitle = '', useVolumeCover = {}, handlers = {}) {
  const selectedVolumeIndexes = resolveSelectedVolumeIndexes(novel.volumes, selectedVolumeIndexesInput);
  const epubMode = ensureValidEpubMode(epubModeInput);

  if (selectedVolumeIndexes.length === 0) {
    throw new Error('Không có tập hợp lệ để tải.');
  }

  const totalChapters = selectedVolumeIndexes.reduce(
    (sum, volumeIndex) => sum + novel.volumes[volumeIndex].chapters.length,
    0
  );

  // Use custom title if provided, otherwise use original title
  const finalTitle = customTitle.trim() || novel.title;
  const safeTitle = sanitizeFileName(finalTitle);
  console.log('[DEBUG] customTitle:', customTitle, '| finalTitle:', finalTitle, '| safeTitle:', safeTitle);
  const novelDir = path.join(DOWNLOADS_DIR, safeTitle);
  await fs.ensureDir(novelDir);

  handlers.onStart?.({
    novel,
    selectedVolumeIndexes,
    epubMode,
    totalChapters,
    novelDir
  });

  handlers.onLog?.(`Bắt đầu tải: ${novel.title}`);

  let processedChapters = 0;
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

    handlers.onLog?.(`Đang xử lý ${volume.title}`);

    const { epubChapters: chapters, tempDir } = await downloadChapters(volume, volumeDir, novel.author, {
      onChapterStart: (chapter, chapterIndex, volumeChapterCount) => {
        handlers.onChapterStart?.({
          novel,
          volume,
          chapter,
          chapterIndex,
          volumeChapterCount,
          processedChapters,
          totalChapters
        });
      },
      onChapterDone: (chapter, chapterIndex, volumeChapterCount) => {
        processedChapters += 1;
        handlers.onChapterDone?.({
          novel,
          volume,
          chapter,
          chapterIndex,
          volumeChapterCount,
          processedChapters,
          totalChapters
        });
      },
      onLog: message => {
        handlers.onLog?.(message);
      }
    });

    allEpubChapters.push(...chapters);
    perVolumeChapters[volumeIndex] = {
      safeVolumeTitle,
      chapters,
      tempDir
    };
    tempImageDirs.push(tempDir);
  }

  const generatedEpubs = [];

  if (epubMode !== '0') {
    await cleanupLegacyEpubOutputs(novel, selectedVolumeIndexes, novelDir, handlers);
  }

  if (epubMode === '1' || epubMode === '3') {
    const epubPath = path.join(novelDir, `${safeTitle}.epub`);
    handlers.onLog?.('Đang đóng gói EPUB tổng...');
    // Use first volume's tempDir for images
    const firstTempDir = tempImageDirs.length > 0 ? tempImageDirs[0] : null;
    await generateEpub(epubPath, finalTitle, novel.author, novel.coverUrl, [...allEpubChapters], firstTempDir);
    generatedEpubs.push(epubPath);
  }

  if (epubMode === '2' || epubMode === '3') {
    for (const volumeIndex of selectedVolumeIndexes) {
      const record = perVolumeChapters[volumeIndex];
      if (!record || record.chapters.length === 0) continue;

      const volume = novel.volumes[volumeIndex];
      const epubPath = path.join(novelDir, `${safeTitle} - ${record.safeVolumeTitle}.epub`);
      handlers.onLog?.(`Đang đóng gói EPUB ${record.safeVolumeTitle}...`);

      // Use volume cover if checkbox is checked and volume has cover, otherwise use novel cover
      const shouldUseVolumeCover = useVolumeCover[volumeIndex] !== false; // default true
      const volumeCover = (shouldUseVolumeCover && volume.coverUrl) ? volume.coverUrl : novel.coverUrl;

      await generateEpub(
        epubPath,
        `${finalTitle} - ${volume.title}`,
        novel.author,
        volumeCover,
        [...record.chapters],
        record.tempDir
      );
      generatedEpubs.push(epubPath);
    }
  }

  if (epubMode === '3') {
    await cleanupIntermediateChapterFiles(volumeDirs, handlers);
  }

  // Keep temp image directories for debugging - DO NOT DELETE
  handlers.onLog?.(`Thư mục ảnh: ${tempImageDirs.join(', ')}`);

  return {
    mode: 'single',
    novelTitle: novel.title,
    novelDir,
    epubFiles: generatedEpubs,
    epubItems: generatedEpubs.map(filePath => ({
      name: path.basename(filePath),
      path: filePath,
      url: toDownloadUrl(filePath)
    })),
    downloadItems: generatedEpubs.map(filePath => ({
      name: path.basename(filePath),
      path: filePath,
      url: toDownloadUrl(filePath)
    })),
    sourceUrl: novel.sourceUrl,
    selectedVolumeIndexes,
    totalChapters,
    processedChapters
  };
}

async function writeBatchReport(report) {
  const reportsDir = path.join(DOWNLOADS_DIR, '_batch_reports');
  await fs.ensureDir(reportsDir);

  const fileName = `valvrare-batch-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const reportPath = path.join(reportsDir, fileName);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  return reportPath;
}

async function performDownload(taskId, payload) {
  updateTask(taskId, {
    status: 'running',
    startedAt: new Date().toISOString(),
    progress: 2
  });

  pushTaskLog(taskId, 'Đang lấy thông tin truyện...');

  const novel = await fetchNovelInfo(payload.url);
  const selectedVolumeIndexes = resolveSelectedVolumeIndexes(novel.volumes, payload.selectedVolumeIndexes);
  const epubMode = ensureValidEpubMode(payload.epubMode);

  if (selectedVolumeIndexes.length === 0) {
    throw new Error('Không có tập hợp lệ để tải.');
  }

  updateTask(taskId, {
    payload: {
      ...payload,
      selectedVolumeIndexes,
      epubMode,
      novelTitle: novel.title
    }
  });

  const totalChapters = selectedVolumeIndexes.reduce(
    (sum, volumeIndex) => sum + novel.volumes[volumeIndex].chapters.length,
    0
  );

  const safeTitle = sanitizeFileName(novel.title);
  const novelDir = path.join(DOWNLOADS_DIR, safeTitle);
  await fs.ensureDir(novelDir);

  pushTaskLog(taskId, `Bắt đầu tải: ${novel.title}`);

  let processedChapters = 0;
  const allEpubChapters = [];
  const perVolumeChapters = {};
  const tempImageDirs = [];

  for (const volumeIndex of selectedVolumeIndexes) {
    const volume = novel.volumes[volumeIndex];
    const safeVolumeTitle = sanitizeFileName(volume.title);
    const volumeDir = path.join(novelDir, safeVolumeTitle);
    await fs.ensureDir(volumeDir);

    pushTaskLog(taskId, `Đang xử lý ${volume.title}`);

    const { epubChapters: chapters, tempDir } = await downloadChapters(volume, volumeDir, novel.author, {
      onChapterStart: (chapter, chapterIndex, volumeChapterCount) => {
        pushTaskLog(
          taskId,
          `Chương ${chapterIndex + 1}/${volumeChapterCount}: ${chapter.title}`
        );
      },
      onChapterDone: () => {
        processedChapters += 1;
        const progress = totalChapters > 0
          ? Math.min(92, 8 + Math.round((processedChapters / totalChapters) * 80))
          : 50;
        updateTask(taskId, { progress });
      },
      onLog: message => {
        pushTaskLog(taskId, message);
      }
    });

    allEpubChapters.push(...chapters);
    perVolumeChapters[volumeIndex] = {
      safeVolumeTitle,
      chapters,
      tempDir
    };
    tempImageDirs.push(tempDir);
  }

  const generatedEpubs = [];

  if (epubMode === '1' || epubMode === '3') {
    const epubPath = path.join(DOWNLOADS_DIR, `${safeTitle}.epub`);
    pushTaskLog(taskId, 'Đang đóng gói EPUB tổng...');
    const firstTempDir = tempImageDirs.length > 0 ? tempImageDirs[0] : null;
    await generateEpub(epubPath, novel.title, novel.author, novel.coverUrl, [...allEpubChapters], firstTempDir);
    generatedEpubs.push(epubPath);
  }

  if (epubMode === '2' || epubMode === '3') {
    for (const volumeIndex of selectedVolumeIndexes) {
      const record = perVolumeChapters[volumeIndex];
      if (!record || record.chapters.length === 0) continue;

      const epubPath = path.join(DOWNLOADS_DIR, `${safeTitle} - ${record.safeVolumeTitle}.epub`);
      pushTaskLog(taskId, `Đang đóng gói EPUB ${record.safeVolumeTitle}...`);
      await generateEpub(
        epubPath,
        `${novel.title} - ${novel.volumes[volumeIndex].title}`,
        novel.author,
        novel.coverUrl,
        [...record.chapters],
        record.tempDir
      );
      generatedEpubs.push(epubPath);
    }
  }

  // Keep temp image directories for debugging - DO NOT DELETE

  updateTask(taskId, {
        status: 'completed',
        progress: 100,
        finishedAt: new Date().toISOString(),
        result: {
          novelTitle: novel.title,
          novelDir,
          epubFiles: generatedEpubs,
          epubItems: generatedEpubs.map(filePath => ({
            name: path.basename(filePath),
            path: filePath,
            url: toDownloadUrl(filePath)
          })),
          sourceUrl: novel.sourceUrl
        }
      });

  pushTaskLog(taskId, 'Hoàn tất.');
}

function startDownloadTask(payload) {
  const task = createTask(payload);

  performDownload(task.id, payload).catch(error => {
    updateTask(task.id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: formatErrorMessage(error)
    });
    pushTaskLog(task.id, `Thất bại: ${formatErrorMessage(error)}`);
  });

  return task;
}

async function performDownload(taskId, payload) {
  updateTask(taskId, {
    status: 'running',
    startedAt: new Date().toISOString(),
    progress: 2
  });

  pushTaskLog(taskId, 'Đang lấy thông tin truyện...');

  console.log('[DEBUG] payload.customTitle:', payload.customTitle);

  const novel = await fetchNovelInfo(payload.url);
  const result = await downloadNovelAssets(
    novel,
    payload.selectedVolumeIndexes,
    payload.epubMode,
    payload.customTitle || '',
    payload.useVolumeCover || {},
    {
      onStart: ({ selectedVolumeIndexes, epubMode }) => {
        updateTask(taskId, {
          payload: {
            ...payload,
            selectedVolumeIndexes,
            epubMode,
            novelTitle: novel.title
          }
        });
      },
    onChapterStart: ({ chapter, chapterIndex, volumeChapterCount }) => {
      pushTaskLog(
        taskId,
        `Chương ${chapterIndex + 1}/${volumeChapterCount}: ${chapter.title}`
      );
    },
    onChapterDone: ({ processedChapters, totalChapters }) => {
      const progress = totalChapters > 0
        ? Math.min(92, 8 + Math.round((processedChapters / totalChapters) * 80))
        : 50;
      updateTask(taskId, { progress });
    },
    onLog: message => {
      pushTaskLog(taskId, message);
    }
  });

  updateTask(taskId, {
    status: 'completed',
    progress: 100,
    finishedAt: new Date().toISOString(),
    result
  });

  pushTaskLog(taskId, 'Hoàn tất.');
}

async function performBatchDownload(taskId, payload) {
  updateTask(taskId, {
    status: 'running',
    startedAt: new Date().toISOString(),
    progress: 1
  });

  const catalogUrl = normalizeWhitespace(payload.catalogUrl || '');
  if (!isValvrareDirectoryUrl(catalogUrl)) {
    throw new Error('URL danh mục Valvrare không hợp lệ.');
  }

  const epubMode = ensureValidEpubMode(String(payload.epubMode || '1'));
  const batchConcurrency = ensureBatchConcurrency(payload.batchConcurrency || 2);
  pushTaskLog(taskId, 'Đang crawl danh mục Valvrare...');

  const directory = await crawlValvrareDirectory();
  const items = directory.items || [];

  if (items.length === 0) {
    throw new Error('Danh mục Valvrare không có truyện nào để tải.');
  }

  updateTask(taskId, {
    payload: {
      ...payload,
      mode: 'batch',
      epubMode,
      batchConcurrency,
      catalogUrl: directory.sourceUrl,
      totalNovels: items.length,
      currentNovelIndex: 0,
      currentNovelTitle: '',
      activeNovelCount: 0,
      completedNovelCount: 0
    }
  });

  pushTaskLog(
    taskId,
    `Đã gom ${items.length} truyện từ ${directory.totalPages} trang. Chạy song song tối đa ${batchConcurrency} truyện.`
  );

  const successes = [];
  const skipped = [];
  const failures = [];
  const activeTitles = new Map();
  const activeRatios = new Map();
  let completedCount = 0;
  let nextIndex = 0;

  const refreshBatchTaskState = () => {
    const currentPayload = getTask(taskId)?.payload || payload;
    const totalActiveRatio = [...activeRatios.values()].reduce((sum, value) => sum + value, 0);
    const totalRatio = items.length > 0 ? (completedCount + totalActiveRatio) / items.length : 1;

    updateTask(taskId, {
      progress: Math.min(98, Math.max(2, 2 + Math.round(totalRatio * 96))),
      payload: {
        ...currentPayload,
        mode: 'batch',
        epubMode,
        batchConcurrency,
        catalogUrl: directory.sourceUrl,
        totalNovels: items.length,
        currentNovelIndex: Math.min(items.length, completedCount + activeTitles.size),
        currentNovelTitle: [...activeTitles.values()].join(' | '),
        activeNovelCount: activeTitles.size,
        completedNovelCount: completedCount
      }
    });
  };

  const processBatchItem = async (index, item) => {
    const currentIndex = index + 1;
    const indexLabel = `${currentIndex}/${items.length}`;
    activeTitles.set(index, item.title);
    activeRatios.set(index, 0);
    refreshBatchTaskState();

    try {
      pushTaskLog(taskId, `[${indexLabel}] Đang lấy thông tin: ${item.title}`);
      const novel = await fetchNovelInfo(item.url);
      activeTitles.set(index, novel.title);
      activeRatios.set(index, 0.05);
      refreshBatchTaskState();
      const existingOutput = await detectExistingNovelOutputs(novel, []);

      if (hasRequestedNovelOutputs(existingOutput, epubMode)) {
        skipped.push({
          title: novel.title,
          sourceUrl: novel.sourceUrl,
          novelDir: existingOutput.novelDir,
          completedKinds: existingOutput.completedKinds,
          epubFiles: existingOutput.existingEpubFiles
        });

        pushTaskLog(
          taskId,
          `[${indexLabel}] Bỏ qua: ${novel.title} (đã có ${existingOutput.completedKinds.join(', ')})`
        );
        return;
      }

      const result = await downloadNovelAssets(novel, [], epubMode, {
        onStart: ({ selectedVolumeIndexes, totalChapters }) => {
          activeTitles.set(index, novel.title);
          activeRatios.set(index, 0.08);
          refreshBatchTaskState();
          pushTaskLog(
            taskId,
            `[${indexLabel}] Bắt đầu tải ${novel.title} (${selectedVolumeIndexes.length} tập, ${totalChapters} chương)`
          );
        },
        onChapterDone: ({ processedChapters, totalChapters }) => {
          const novelRatio = totalChapters > 0 ? processedChapters / totalChapters : 1;
          activeRatios.set(index, novelRatio);
          refreshBatchTaskState();
        },
        onLog: message => {
          if (message.startsWith('[ok]') || message.startsWith('[cache]')) return;
          pushTaskLog(taskId, `[${indexLabel}] ${message}`);
        }
      });

      successes.push({
        title: result.novelTitle,
        sourceUrl: result.sourceUrl,
        novelDir: result.novelDir,
        chapterCount: result.totalChapters,
        epubFiles: result.epubFiles
      });

      pushTaskLog(taskId, `[${indexLabel}] Hoàn tất: ${result.novelTitle}`);
    } catch (error) {
      const formattedError = formatErrorMessage(error);
      failures.push({
        title: item.title,
        url: item.url,
        error: formattedError
      });

      pushTaskLog(taskId, `[${indexLabel}] Thất bại: ${item.title} | ${formattedError}`);
    } finally {
      activeTitles.delete(index);
      activeRatios.delete(index);
      completedCount += 1;
      refreshBatchTaskState();
    }
  };

  refreshBatchTaskState();

  const workers = Array.from({ length: Math.min(batchConcurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= items.length) {
        return;
      }

      await processBatchItem(index, items[index]);
    }
  });

  await Promise.all(workers);

  const report = {
    generatedAt: new Date().toISOString(),
    catalogUrl: directory.sourceUrl,
    totalPages: directory.totalPages,
    totalItems: items.length,
    batchConcurrency,
    downloadedCount: successes.length,
    skippedCount: skipped.length,
    successCount: successes.length + skipped.length,
    failureCount: failures.length,
    epubMode,
    successes,
    skipped,
    failures
  };

  const reportPath = await writeBatchReport(report);
  const reportItems = [{
    name: path.basename(reportPath),
    path: reportPath,
    url: toDownloadUrl(reportPath)
  }];

  updateTask(taskId, {
    status: 'completed',
    progress: 100,
    finishedAt: new Date().toISOString(),
    result: {
      mode: 'batch',
      catalogUrl: directory.sourceUrl,
      totalPages: directory.totalPages,
      totalItems: items.length,
      batchConcurrency,
      downloadedCount: successes.length,
      skippedCount: skipped.length,
      successCount: successes.length + skipped.length,
      failureCount: failures.length,
      skippedItems: skipped.slice(0, 25),
      failedItems: failures.slice(0, 25),
      reportItems,
      downloadItems: reportItems
    }
  });

  pushTaskLog(
    taskId,
    `Hoàn tất batch. Tải mới ${successes.length}, bỏ qua ${skipped.length}, thất bại ${failures.length}.`
  );
}

function startDownloadTask(payload) {
  const task = createTask(payload);

  performDownload(task.id, payload).catch(error => {
    updateTask(task.id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: formatErrorMessage(error)
    });
    pushTaskLog(task.id, `Thất bại: ${formatErrorMessage(error)}`);
  });

  return task;
}

function startBatchDownloadTask(payload) {
  const task = createTask(payload);

  performBatchDownload(task.id, payload).catch(error => {
    updateTask(task.id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: formatErrorMessage(error)
    });
    pushTaskLog(task.id, `Thất bại: ${formatErrorMessage(error)}`);
  });

  return task;
}

function parseSelectedVolumeIndexes(body) {
  if (!Array.isArray(body.selectedVolumeIndexes)) return [];
  return body.selectedVolumeIndexes.map(value => Number.parseInt(value, 10));
}

app.get('/api/status', (req, res) => {
  res.json(getStatus());
});

app.get('/api/dns-profiles', (req, res) => {
  res.json({
    current: dnsProfile,
    profiles: Object.values(DNS_PROFILES)
  });
});

app.post('/api/dns', (req, res) => {
  const { profileId, servers } = req.body || {};

  if (profileId && DNS_PROFILES[profileId]) {
    applyDnsProfile(DNS_PROFILES[profileId]);
    res.json({ ok: true, current: dnsProfile });
    return;
  }

  if (profileId === 'custom') {
    const normalizedServers = Array.isArray(servers) ? servers.map(item => String(item).trim()).filter(Boolean) : [];
    const invalidServers = normalizedServers.filter(server => net.isIP(server) === 0);

    if (normalizedServers.length === 0 || invalidServers.length > 0) {
      res.status(400).json({ error: `DNS không hợp lệ: ${invalidServers.join(', ') || 'trống'}` });
      return;
    }

    applyDnsProfile(createDnsProfile(`Tự nhập (${normalizedServers.join(', ')})`, normalizedServers));
    res.json({ ok: true, current: dnsProfile });
    return;
  }

  res.status(400).json({ error: 'Không nhận diện được cấu hình DNS.' });
});

app.get('/api/recommendations', async (req, res) => {
  try {
    const items = await fetchHomepageRecommendations();
    res.json({ items, status: getStatus() });
  } catch (error) {
    res.status(500).json({ error: formatErrorMessage(error) });
  }
});

app.get('/api/catalog', async (req, res) => {
  const url = normalizeWhitespace(req.query.url || '');
  if (url && !isValvrareDirectoryUrl(url)) {
    res.status(400).json({ error: 'URL danh mục Valvrare không hợp lệ.' });
    return;
  }

  try {
    const directory = await crawlValvrareDirectory();
    res.json({
      items: directory.items,
      catalog: {
        sourceUrl: directory.sourceUrl,
        totalPages: directory.totalPages,
        totalItems: directory.totalItems
      },
      status: getStatus()
    });
  } catch (error) {
    res.status(500).json({ error: formatErrorMessage(error) });
  }
});

app.get('/api/search', async (req, res) => {
  const query = normalizeWhitespace(req.query.q || '');
  if (!query) {
    res.status(400).json({ error: 'Từ khóa tìm kiếm không được để trống.' });
    return;
  }

  try {
    const items = await searchNovels(query);
    res.json({ items, query, status: getStatus() });
  } catch (error) {
    res.status(500).json({ error: formatErrorMessage(error) });
  }
});

app.get('/api/novel', async (req, res) => {
  const url = normalizeWhitespace(req.query.url || '');
  if (!url) {
    res.status(400).json({ error: 'Thiếu URL truyện.' });
    return;
  }

  try {
    const novel = await fetchNovelInfo(url);
    res.json({ novel, status: getStatus() });
  } catch (error) {
    res.status(500).json({ error: formatErrorMessage(error) });
  }
});

app.post('/api/batch-download', (req, res) => {
  const catalogUrl = normalizeWhitespace(req.body?.catalogUrl || '');
  if (!catalogUrl || !isValvrareDirectoryUrl(catalogUrl)) {
    res.status(400).json({ error: 'Thiếu hoặc sai URL danh mục Valvrare.' });
    return;
  }

  const task = startBatchDownloadTask({
    mode: 'batch',
    catalogUrl,
    epubMode: ensureValidEpubMode(String(req.body?.epubMode || '1')),
    batchConcurrency: ensureBatchConcurrency(req.body?.batchConcurrency || 2)
  });

  res.status(202).json({ task: serializeTask(task) });
});

app.post('/api/download', (req, res) => {
  const url = normalizeWhitespace(req.body?.url || '');
  if (!url) {
    res.status(400).json({ error: 'Thiếu URL truyện.' });
    return;
  }

  const task = startDownloadTask({
    url,
    epubMode: ensureValidEpubMode(String(req.body?.epubMode || '1')),
    selectedVolumeIndexes: parseSelectedVolumeIndexes(req.body || {}),
    customTitle: req.body?.customTitle || '',
    useVolumeCover: req.body?.useVolumeCover || {}
  });

  res.status(202).json({ task: serializeTask(task) });
});

app.get('/api/tasks/:taskId', (req, res) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Không tìm thấy task.' });
    return;
  }

  res.json({ task: serializeTask(task) });
});

app.get('/api/tasks', (req, res) => {
  res.json({
    tasks: [...tasks.values()].map(serializeTask)
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const port = Number.parseInt(process.env.PORT || '3000', 10);

app.listen(port, () => {
  console.log(`HAKO web server đang chạy tại http://localhost:${port}`);
});
