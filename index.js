const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs-extra');
const path = require('path');
const EpubGen = require('epub-gen-memory').default;
const readline = require('readline');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Safari/537.36'
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function clearScreen() {
  process.stdout.write('\x1b[2J\x1b[H');
}

function color(text, code) {
  return `\x1b[${code}m${text}\x1b[0m`;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Decryption ───────────────────────────────────────────────
function decodeProtected(dataC, dataK, dataS) {
  let e = [];
  try { e = JSON.parse(dataC); } catch { return ''; }
  if (!Array.isArray(e) || e.length === 0) return '';
  e.sort((a, b) => parseInt(a.substring(0, 4), 10) - parseInt(b.substring(0, 4), 10));
  let result = '';
  for (const item of e) {
    let s = item.substring(4);
    if (dataS === 'xor_shuffle') {
      const buf = Buffer.from(s, 'base64');
      const resBuf = Buffer.alloc(buf.length);
      for (let i = 0; i < buf.length; i++) resBuf[i] = buf[i] ^ dataK.charCodeAt(i % dataK.length);
      result += resBuf.toString('utf-8');
    } else if (dataS === 'base64_reverse') {
      result += Buffer.from(s.split('').reverse().join(''), 'base64').toString('utf-8');
    } else {
      result += Buffer.from(s, 'base64').toString('utf-8');
    }
  }
  return result;
}

// ─── EPUB Generator ───────────────────────────────────────────
async function generateEpub(epubPath, title, author, coverUrl, chapters) {
  const opts = {
    title, author,
    publisher: 'Hako Downloader',
    tocTitle: 'Mục Lục',
    ignoreFailedDownloads: true
  };
  if (coverUrl) opts.cover = coverUrl;

  try {
    const buf = await EpubGen(opts, chapters);
    await fs.writeFile(epubPath, buf);
    console.log(color(`  ✓ EPUB: ${epubPath}`, '32'));
  } catch (err) {
    console.log(color(`  ⚠ Lỗi ảnh: ${err.message}. Thử lại không ảnh...`, '33'));
    for (const ch of chapters) {
      const $c = cheerio.load(ch.content);
      $c('img').remove();
      ch.content = $c.html();
    }
    delete opts.cover;
    const buf2 = await EpubGen(opts, chapters);
    await fs.writeFile(epubPath, buf2);
    console.log(color(`  ✓ EPUB (không ảnh): ${epubPath}`, '32'));
  }
}

// ─── Download chapters ────────────────────────────────────────
async function downloadChapters(volume, volDir, author) {
  const epubChapters = [];
  for (const [index, chapter] of volume.chapters.entries()) {
    const tag = `[${index + 1}/${volume.chapters.length}]`;
    process.stdout.write(`  ${tag} ${chapter.title} `);
    const safeChapTitle = chapter.title.replace(/[\/\\?%*:|"<>]/g, '-');
    const txtPath = path.join(volDir, `${safeChapTitle}.txt`);
    const htmlPath = path.join(volDir, `${safeChapTitle}.html`);
    let contentHtml = '';

    if (fs.existsSync(htmlPath) && fs.existsSync(txtPath)) {
      console.log(color('(cache)', '90'));
      contentHtml = await fs.readFile(htmlPath, 'utf-8');
    } else {
      try {
        const chapRes = await axios.get(chapter.url, { headers: HEADERS });
        let $chap = cheerio.load(chapRes.data);
        const protectedDiv = $chap('#chapter-c-protected');
        if (protectedDiv.length > 0) {
          const dataC = protectedDiv.attr('data-c');
          const dataK = protectedDiv.attr('data-k') || '';
          const dataS = protectedDiv.attr('data-s') || 'none';
          if (dataC) {
            const html = decodeProtected(dataC, dataK, dataS);
            if (html) { protectedDiv.replaceWith(html); $chap = cheerio.load($chap.html()); }
          }
        }
        contentHtml = $chap('#chapter-content').html();
        if (!contentHtml) { console.log(color('(trống)', '33')); continue; }

        let txContent = volume.title + '\n\n' + chapter.title + '\n\n';
        $chap('#chapter-content > p').each((k, p) => {
          const img = $chap(p).find('img').attr('src');
          if (img) txContent += `[Ảnh: ${img}]\n\n`;
          else { const t = $chap(p).text().trim(); if (t) txContent += t + '\n\n'; }
        });
        await fs.writeFile(txtPath, txContent, 'utf-8');
        await fs.writeFile(htmlPath, contentHtml, 'utf-8');
        console.log(color('✓', '32'));
      } catch (e) {
        console.log(color(`✗ ${e.message}`, '31'));
        if (e.response && e.response.status === 429) { await sleep(10000); }
        continue;
      }
      await sleep(2000);
    }
    epubChapters.push({ title: `${volume.title} - ${chapter.title}`, author, content: contentHtml });
  }
  return epubChapters;
}

// ─── Fetch novel info ─────────────────────────────────────────
async function fetchNovelInfo(url) {
  const res = await axios.get(url, { headers: HEADERS });
  const $ = cheerio.load(res.data);
  const title = $('.series-name a').text().trim() || $('title').text().trim();
  const author = $('.series-information .info-item:contains("Tác giả") .info-value a').text().trim() || 'Khuyết danh';
  const rawCover = $('.series-cover .img-in-ratio').attr('style') || '';
  const coverUrl = rawCover.match(/url\(['"]?(.*?)['"]?\)/)?.[1] || '';
  const volumes = [];
  $('.volume-list').each((i, el) => {
    const volTitle = $(el).find('.sect-title').text().trim();
    const chapters = [];
    $(el).find('.list-chapters li').each((j, li) => {
      const a = $(li).find('.chapter-name a');
      let href = a.attr('href');
      if (href && href.startsWith('/')) href = 'https://docln.net' + href;
      chapters.push({ title: a.text().trim(), url: href });
    });
    if (chapters.length > 0) volumes.push({ title: volTitle, chapters });
  });
  return { title, author, coverUrl, volumes };
}

// ─── Banner ───────────────────────────────────────────────────
function printBanner() {
  clearScreen();
  console.log(color('╔══════════════════════════════════════════════╗', '36'));
  console.log(color('║     📚  HAKO LIGHT NOVEL DOWNLOADER  📚     ║', '36;1'));
  console.log(color('║          docln.net / ln.hako.vn              ║', '36'));
  console.log(color('╚══════════════════════════════════════════════╝', '36'));
  console.log();
}

// ─── Main Menu ────────────────────────────────────────────────
async function main() {
  while (true) {
    printBanner();
    console.log(color('  [1]', '33') + ' Tải truyện mới');
    console.log(color('  [0]', '33') + ' Thoát');
    console.log();
    const choice = (await ask(color('  ▸ Chọn: ', '36'))).trim();

    if (choice === '0') {
      console.log(color('\n  Tạm biệt! 👋\n', '36'));
      rl.close();
      return;
    }
    if (choice !== '1') continue;

    // ── Nhập link ──
    console.log();
    const url = (await ask(color('  ▸ Nhập link truyện: ', '36'))).trim();
    if (!url) continue;

    console.log(color('\n  Đang lấy thông tin truyện...', '90'));
    let novel;
    try {
      novel = await fetchNovelInfo(url);
    } catch (e) {
      console.log(color(`\n  ✗ Không thể lấy thông tin: ${e.message}`, '31'));
      await ask(color('\n  Nhấn Enter để quay lại...', '90'));
      continue;
    }

    const { title, author, coverUrl, volumes } = novel;
    const safeTitle = title.replace(/[\/\\?%*:|"<>]/g, '-');
    const novelDir = path.join(__dirname, 'downloads', safeTitle);
    await fs.ensureDir(novelDir);

    // ── Hiển thị thông tin ──
    console.log();
    console.log(color('  ┌─ Thông tin truyện ────────────────────', '36'));
    console.log(color('  │', '36') + ` Tiêu đề: ${color(title, '1')}`);
    console.log(color('  │', '36') + ` Tác giả: ${author}`);
    console.log(color('  │', '36') + ` Số tập : ${volumes.length}`);
    volumes.forEach((v, i) => {
      console.log(color('  │', '36') + `   ${color(`[${i + 1}]`, '33')} ${v.title} (${v.chapters.length} chương)`);
    });
    console.log(color('  └──────────────────────────────────────', '36'));

    // ── Chọn EPUB mode ──
    console.log();
    console.log(color('  Chế độ đóng gói EPUB:', '36;1'));
    console.log(color('  [1]', '33') + ' Tạo 1 file EPUB chứa tất cả các tập');
    console.log(color('  [2]', '33') + ' Tạo 1 file EPUB riêng cho mỗi tập');
    console.log(color('  [3]', '33') + ' Cả hai (tất cả + từng tập)');
    console.log(color('  [0]', '33') + ' Chỉ tải TXT, không tạo EPUB');
    console.log();
    const epubMode = (await ask(color('  ▸ Chọn chế độ EPUB: ', '36'))).trim();

    // ── Chọn tập ──
    console.log();
    console.log(color('  Chọn tập cần tải:', '36;1'));
    console.log(color('  [0]', '33') + ' Tải tất cả');
    volumes.forEach((v, i) => {
      console.log(color(`  [${i + 1}]`, '33') + ` ${v.title}`);
    });
    console.log();
    const volChoice = (await ask(color('  ▸ Chọn (ví dụ: 0 hoặc 1,3,5): ', '36'))).trim();

    let selectedVolumes = [];
    if (volChoice === '0' || volChoice === '') {
      selectedVolumes = volumes.map((v, i) => i);
    } else {
      selectedVolumes = volChoice.split(',').map(s => parseInt(s.trim()) - 1).filter(i => i >= 0 && i < volumes.length);
    }
    if (selectedVolumes.length === 0) {
      console.log(color('  ✗ Không có tập nào được chọn.', '31'));
      await ask(color('\n  Nhấn Enter để quay lại...', '90'));
      continue;
    }

    // ── Tải chương ──
    console.log(color('\n  ═══ BẮT ĐẦU TẢI ═══\n', '36;1'));
    const allEpubChapters = [];
    const perVolumeChapters = {}; // volIndex -> chapters[]

    for (const vi of selectedVolumes) {
      const volume = volumes[vi];
      console.log(color(`\n  ── ${volume.title} ──`, '35;1'));
      const safeVolTitle = volume.title.replace(/[\/\\?%*:|"<>]/g, '-');
      const volDir = path.join(novelDir, safeVolTitle);
      await fs.ensureDir(volDir);

      const chaptersData = await downloadChapters(volume, volDir, author);
      allEpubChapters.push(...chaptersData);
      perVolumeChapters[vi] = { safeVolTitle, chapters: chaptersData };
    }

    // ── Đóng gói EPUB ──
    if (epubMode === '1' || epubMode === '3') {
      console.log(color('\n  Đóng gói EPUB (tất cả)...', '36'));
      const epubPath = path.join(__dirname, 'downloads', `${safeTitle}.epub`);
      await generateEpub(epubPath, title, author, coverUrl, [...allEpubChapters]);
    }

    if (epubMode === '2' || epubMode === '3') {
      console.log(color('\n  Đóng gói EPUB (từng tập)...', '36'));
      for (const vi of selectedVolumes) {
        const { safeVolTitle, chapters } = perVolumeChapters[vi];
        if (!chapters || chapters.length === 0) continue;
        const epubPath = path.join(__dirname, 'downloads', `${safeTitle} - ${safeVolTitle}.epub`);
        await generateEpub(epubPath, `${title} - ${volumes[vi].title}`, author, coverUrl, [...chapters]);
      }
    }

    // ── Hoàn tất ──
    console.log(color('\n  ═══════════════════════════════════════', '32'));
    console.log(color('  ✓ HOÀN TẤT!', '32;1'));
    console.log(color(`  TXT: ${novelDir}`, '32'));
    if (epubMode !== '0') console.log(color(`  EPUB: ${path.join(__dirname, 'downloads')}`, '32'));
    console.log(color('  ═══════════════════════════════════════\n', '32'));

    await ask(color('  Nhấn Enter để quay lại menu...', '90'));
  }
}

main();
