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

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'vi,en-US;q=0.9,en;q=0.8',
  Referer: 'https://docln.net/'
};

const SITE_ORIGINS = [
  'https://docln.net',
  'https://docln.sbs',
  'https://ln.hako.vn'
];

const DNS_PROFILES = {
  system: { id: 'system', label: 'Hệ thống mặc định', servers: null },
  cloudflare: { id: 'cloudflare', label: 'Cloudflare (1.1.1.1, 1.0.0.1)', servers: ['1.1.1.1', '1.0.0.1'] },
  google: { id: 'google', label: 'Google (8.8.8.8, 8.8.4.4)', servers: ['8.8.8.8', '8.8.4.4'] }
};

const EPUB_MODES = ['0', '1', '2', '3'];

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
  return value.replace(/[\/\\?%*:|"<>]/g, '-').trim();
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
  return /^\/truyen\/\d+(?:-[^/?#]+)?\/?$/.test(pathname);
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
      const response = await httpClient.get(candidateUrl, { responseType: 'text' });
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

  return author || 'Khuyet danh';
}

function extractCoverUrl($, pageUrl) {
  const rawCoverStyle = $('.series-cover .img-in-ratio').first().attr('style') || '';
  const coverFromStyle = rawCoverStyle.match(/url\(['"]?(.*?)['"]?\)/)?.[1] || '';
  const coverFromImage = $('.series-cover img').first().attr('src')
    || $('meta[property="og:image"]').attr('content')
    || '';

  return normalizeUrl(coverFromStyle || coverFromImage, pageUrl);
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

async function fetchNovelInfo(url) {
  const page = await fetchHtmlPage(url);
  const $ = cheerio.load(page.html);

  const title = normalizeWhitespace($('.series-name a').first().text())
    || normalizeWhitespace($('h1').first().text())
    || normalizeWhitespace($('title').text().replace(/\s*-\s*Cổng Light Novel.*$/i, ''))
    || 'Chưa rõ tiêu đề';

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

async function generateEpub(epubPath, title, author, coverUrl, chapters) {
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
        const chapterResponse = await httpClient.get(chapter.url);
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

        contentHtml = $chapter('#chapter-content').html();
        if (!contentHtml) {
          handlers.onLog?.(`[bỏ qua] ${chapter.title} (rỗng)`);
          continue;
        }

        let textContent = `${volume.title}\n\n${chapter.title}\n\n`;
        $chapter('#chapter-content > p').each((_, paragraph) => {
          const imageUrl = $chapter(paragraph).find('img').attr('src');
          if (imageUrl) {
            textContent += `[Ảnh: ${imageUrl}]\n\n`;
            return;
          }

          const line = $chapter(paragraph).text().trim();
          if (line) textContent += `${line}\n\n`;
        });

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

    epubChapters.push({
      title: `${volume.title} - ${chapter.title}`,
      author,
      content: contentHtml
    });

    handlers.onChapterDone?.(chapter, index, volume.chapters.length);
  }

  return epubChapters;
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

function resolveSelectedVolumeIndexes(volumes, selectedVolumeIndexes) {
  if (!Array.isArray(selectedVolumeIndexes) || selectedVolumeIndexes.length === 0) {
    return volumes.map((_, index) => index);
  }

  const indexes = selectedVolumeIndexes
    .map(value => Number.parseInt(value, 10))
    .filter(index => Number.isInteger(index) && index >= 0 && index < volumes.length);

  return [...new Set(indexes)];
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

  for (const volumeIndex of selectedVolumeIndexes) {
    const volume = novel.volumes[volumeIndex];
    const safeVolumeTitle = sanitizeFileName(volume.title);
    const volumeDir = path.join(novelDir, safeVolumeTitle);
    await fs.ensureDir(volumeDir);

    pushTaskLog(taskId, `Đang xử lý ${volume.title}`);

    const chapters = await downloadChapters(volume, volumeDir, novel.author, {
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
      chapters
    };
  }

  const generatedEpubs = [];

  if (epubMode === '1' || epubMode === '3') {
    const epubPath = path.join(DOWNLOADS_DIR, `${safeTitle}.epub`);
    pushTaskLog(taskId, 'Đang đóng gói EPUB tổng...');
    await generateEpub(epubPath, novel.title, novel.author, novel.coverUrl, [...allEpubChapters]);
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
        [...record.chapters]
      );
      generatedEpubs.push(epubPath);
    }
  }

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

app.post('/api/download', (req, res) => {
  const url = normalizeWhitespace(req.body?.url || '');
  if (!url) {
    res.status(400).json({ error: 'Thiếu URL truyện.' });
    return;
  }

  const task = startDownloadTask({
    url,
    epubMode: ensureValidEpubMode(String(req.body?.epubMode || '1')),
    selectedVolumeIndexes: parseSelectedVolumeIndexes(req.body || {})
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
