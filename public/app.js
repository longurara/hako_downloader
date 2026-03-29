const COVER_PLACEHOLDER = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 460">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#0f6d66"/>
        <stop offset="100%" stop-color="#b46b48"/>
      </linearGradient>
    </defs>
    <rect width="320" height="460" fill="#efe3cf"/>
    <rect x="20" y="20" width="280" height="420" rx="18" fill="url(#g)" opacity="0.18"/>
    <rect x="54" y="64" width="212" height="10" rx="5" fill="#6c6158" opacity="0.52"/>
    <rect x="54" y="92" width="168" height="10" rx="5" fill="#6c6158" opacity="0.28"/>
    <rect x="54" y="136" width="212" height="208" rx="18" fill="#fffaf2" opacity="0.92"/>
    <path d="M92 294 L134 248 L180 286 L220 236 L256 294 Z" fill="#b46b48" opacity="0.8"/>
    <circle cx="126" cy="194" r="24" fill="#d59d45" opacity="0.74"/>
  </svg>
`);

const state = {
  currentNovel: null,
  currentResults: [],
  currentTaskId: null,
  taskPollTimer: null,
  dnsProfiles: []
};

const elements = {
  siteStatus: document.querySelector('#siteStatus'),
  dnsStatus: document.querySelector('#dnsStatus'),
  loadRecommendationsBtn: document.querySelector('#loadRecommendationsBtn'),
  searchForm: document.querySelector('#searchForm'),
  searchInput: document.querySelector('#searchInput'),
  directUrlForm: document.querySelector('#directUrlForm'),
  directUrlInput: document.querySelector('#directUrlInput'),
  dnsSelect: document.querySelector('#dnsSelect'),
  customDnsInput: document.querySelector('#customDnsInput'),
  applyDnsBtn: document.querySelector('#applyDnsBtn'),
  resultsTitle: document.querySelector('#resultsTitle'),
  resultsCount: document.querySelector('#resultsCount'),
  resultsList: document.querySelector('#resultsList'),
  detailEmpty: document.querySelector('#detailEmpty'),
  detailView: document.querySelector('#detailView'),
  coverImage: document.querySelector('#coverImage'),
  novelTitle: document.querySelector('#novelTitle'),
  novelAuthor: document.querySelector('#novelAuthor'),
  novelStats: document.querySelector('#novelStats'),
  novelSource: document.querySelector('#novelSource'),
  novelSummary: document.querySelector('#novelSummary'),
  selectionSummary: document.querySelector('#selectionSummary'),
  epubModeSelect: document.querySelector('#epubModeSelect'),
  selectAllVolumesBtn: document.querySelector('#selectAllVolumesBtn'),
  clearVolumesBtn: document.querySelector('#clearVolumesBtn'),
  downloadBtn: document.querySelector('#downloadBtn'),
  volumeMeta: document.querySelector('#volumeMeta'),
  volumeList: document.querySelector('#volumeList'),
  taskState: document.querySelector('#taskState'),
  progressFill: document.querySelector('#progressFill'),
  progressText: document.querySelector('#progressText'),
  taskSummary: document.querySelector('#taskSummary'),
  taskDownloads: document.querySelector('#taskDownloads'),
  taskLogs: document.querySelector('#taskLogs')
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function getCoverSource(url) {
  return url || COVER_PLACEHOLDER;
}

function getHostnameLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return 'unknown';
  }
}

function getPathPreview(url) {
  try {
    const pathname = new URL(url).pathname.replace(/\/$/, '');
    return pathname || '/';
  } catch {
    return url || '';
  }
}

function formatTaskStateLabel(status) {
  const labels = {
    queued: 'Đang xếp hàng',
    running: 'Đang tải',
    completed: 'Hoàn tất',
    failed: 'Thất bại'
  };

  return labels[status] || 'Chưa có task';
}

function renderStatPills(items) {
  return items.map(item => `<span class="stat-pill">${escapeHtml(item)}</span>`).join('');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      'Content-Type': 'application/json'
    },
    ...options
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || 'Yeu cau that bai.');
  }

  return data;
}

function setStatus(status) {
  if (!status) return;
  elements.siteStatus.textContent = `Trang: ${status.site || '...'}`;
  elements.dnsStatus.textContent = `DNS: ${status.dns || '...'}`;
}

function setResultsTitle(title, count) {
  elements.resultsTitle.textContent = title;
  elements.resultsCount.textContent = count ? `${count} truyện` : '';
}

function setTaskState(status) {
  const resolvedStatus = status || 'idle';
  elements.taskState.dataset.state = resolvedStatus;
  elements.taskState.textContent = formatTaskStateLabel(status);
}

function updateDownloadButtonState() {
  const selectedVolumeCount = getSelectedVolumeIndexes().length;
  elements.downloadBtn.disabled = !state.currentNovel || selectedVolumeCount === 0;
}

function renderResults(items) {
  state.currentResults = items;

  if (!items.length) {
    elements.resultsList.innerHTML = '<p class="error-text">Không có dữ liệu để hiển thị.</p>';
    return;
  }

  elements.resultsList.innerHTML = items.map((item, index) => {
    const hostLabel = getHostnameLabel(item.url);
    const pathPreview = getPathPreview(item.url);
    const marker = item.count >= 3 ? 'Nổi bật' : 'Đề xuất';

    return `
      <button class="result-card ${state.currentNovel?.sourceUrl === item.url ? 'active' : ''}" data-index="${index}">
        <img src="${escapeHtml(getCoverSource(item.imageUrl))}" alt="${escapeHtml(item.title)}" loading="lazy">
        <div class="result-body">
          <div class="result-meta">
            <span class="result-host">${escapeHtml(hostLabel)}</span>
            <span class="result-pill">${escapeHtml(marker)}</span>
          </div>
          <h4>${escapeHtml(item.title)}</h4>
          <p class="result-path">${escapeHtml(pathPreview)}</p>
        </div>
      </button>
    `;
  }).join('');
}

function updateSelectionSummary() {
  if (!state.currentNovel) {
    elements.selectionSummary.textContent = 'Chưa chọn tập nào.';
    updateDownloadButtonState();
    return;
  }

  const selectedVolumeIndexes = getSelectedVolumeIndexes();
  if (!selectedVolumeIndexes.length) {
    elements.selectionSummary.textContent = 'Chưa chọn tập nào để tải.';
    updateDownloadButtonState();
    return;
  }

  const selectedChapterCount = selectedVolumeIndexes.reduce((sum, index) => {
    const volume = state.currentNovel.volumes[index];
    return sum + (volume ? volume.chapters.length : 0);
  }, 0);

  elements.selectionSummary.textContent = `Đã chọn ${selectedVolumeIndexes.length} tập / ${selectedChapterCount} chương`;
  updateDownloadButtonState();
}

function renderNovelDetail(novel) {
  const totalChapters = novel.volumes.reduce((sum, volume) => sum + volume.chapters.length, 0);

  state.currentNovel = novel;
  elements.detailEmpty.classList.add('hidden');
  elements.detailView.classList.remove('hidden');
  elements.coverImage.src = getCoverSource(novel.coverUrl);
  elements.coverImage.alt = novel.title;
  elements.novelTitle.textContent = novel.title;
  elements.novelAuthor.textContent = novel.author ? `Tác giả: ${novel.author}` : 'Tác giả: Chưa rõ';
  elements.novelStats.innerHTML = renderStatPills([
    `${novel.volumes.length} tập`,
    `${totalChapters} chương`,
    getHostnameLabel(novel.sourceUrl)
  ]);
  elements.novelSource.href = novel.sourceUrl;
  elements.novelSource.textContent = 'Mở trang gốc';
  elements.novelSummary.textContent = novel.summary || 'Chưa có tóm tắt.';
  elements.volumeMeta.textContent = `${novel.volumes.length} tập`;

  elements.volumeList.innerHTML = novel.volumes.map((volume, index) => {
    const previewChapters = volume.chapters
      .slice(0, 5)
      .map(chapter => `<li>${escapeHtml(chapter.title)}</li>`)
      .join('');
    const hiddenCount = Math.max(0, volume.chapters.length - 5);

    return `
      <label class="volume-card">
        <div class="volume-card-main">
          <div class="volume-copy">
            <span class="volume-index">Tập ${String(index + 1).padStart(2, '0')}</span>
            <h4>${escapeHtml(volume.title)}</h4>
            <p class="volume-note">${volume.chapters.length} chương có thể tải</p>
          </div>
          <input type="checkbox" class="volume-checkbox" value="${index}" checked>
        </div>
        <ul class="chapter-preview">
          ${previewChapters}
          ${hiddenCount > 0 ? `<li class="chapter-preview-more">+${hiddenCount} chương nữa</li>` : ''}
        </ul>
      </label>
    `;
  }).join('');

  updateSelectionSummary();
}

function getSelectedVolumeIndexes() {
  return [...document.querySelectorAll('.volume-checkbox:checked')]
    .map(input => Number.parseInt(input.value, 10))
    .filter(Number.isInteger);
}

function clearTaskDownloads() {
  elements.taskDownloads.innerHTML = '';
  elements.taskDownloads.classList.add('hidden');
}

function renderTaskDownloads(task) {
  const epubItems = (task.result?.epubItems || []).filter(item => item.url);

  if (!epubItems.length) {
    clearTaskDownloads();
    return;
  }

  elements.taskDownloads.innerHTML = `
    <p class="download-title">File EPUB sẵn sàng:</p>
    <div class="download-links">
      ${epubItems.map(item => `
        <a class="download-link" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">
          ${escapeHtml(item.name)}
        </a>
      `).join('')}
    </div>
  `;
  elements.taskDownloads.classList.remove('hidden');
}

function renderTask(task) {
  if (!task) {
    setTaskState();
    elements.progressFill.style.width = '0%';
    elements.progressText.textContent = '0%';
    elements.taskSummary.textContent = 'Chưa có tác vụ nào đang chạy.';
    clearTaskDownloads();
    elements.taskLogs.textContent = '';
    elements.taskLogs.classList.add('hidden');
    return;
  }

  setTaskState(task.status);
  elements.taskSummary.classList.remove('error-text');
  elements.progressFill.style.width = `${task.progress || 0}%`;
  elements.progressText.textContent = `${task.progress || 0}%`;
  elements.taskLogs.classList.remove('hidden');

  if (task.status === 'completed') {
    renderTaskDownloads(task);
    elements.taskSummary.textContent = `Hoàn tất: ${task.result?.novelTitle || ''}`;
    elements.taskLogs.textContent = [
      `Thư mục TXT: ${task.result?.novelDir || ''}`,
      ...(task.logs || []).map(log => `[${log.at}] ${log.message}`)
    ].filter(Boolean).join('\n');
    stopTaskPolling();
    return;
  }

  clearTaskDownloads();

  if (task.status === 'failed') {
    elements.taskSummary.textContent = `Thất bại: ${task.error || 'Không rõ lỗi'}`;
    elements.taskSummary.classList.add('error-text');
    elements.taskLogs.textContent = (task.logs || []).map(log => `[${log.at}] ${log.message}`).join('\n');
    stopTaskPolling();
    return;
  }

  elements.taskSummary.textContent = task.payload?.novelTitle
    ? `Đang xử lý: ${task.payload.novelTitle}`
    : 'Đang chuẩn bị tải...';
  elements.taskLogs.textContent = (task.logs || []).map(log => `[${log.at}] ${log.message}`).join('\n');
}

function stopTaskPolling() {
  if (state.taskPollTimer) {
    clearInterval(state.taskPollTimer);
    state.taskPollTimer = null;
  }
}

function startTaskPolling(taskId) {
  stopTaskPolling();
  state.currentTaskId = taskId;

  const poll = async () => {
    try {
      const data = await api(`/api/tasks/${taskId}`);
      renderTask(data.task);
    } catch (error) {
      elements.taskSummary.textContent = error.message;
      elements.taskSummary.classList.add('error-text');
      stopTaskPolling();
    }
  };

  poll();
  state.taskPollTimer = setInterval(poll, 1500);
}

async function loadStatus() {
  const status = await api('/api/status');
  setStatus(status);
}

async function loadDnsProfiles() {
  const data = await api('/api/dns-profiles');
  state.dnsProfiles = data.profiles;
  elements.dnsStatus.textContent = `DNS: ${data.current?.label || '...'}`;

  elements.dnsSelect.innerHTML = [
    ...state.dnsProfiles.map(profile => `<option value="${profile.id}">${profile.label}</option>`),
    '<option value="custom">Tự nhập DNS</option>'
  ].join('');

  const currentProfile = state.dnsProfiles.find(profile => profile.label === data.current.label);
  elements.dnsSelect.value = currentProfile?.id || 'custom';
  elements.customDnsInput.value = Array.isArray(data.current?.servers) ? data.current.servers.join(', ') : '';
}

async function loadRecommendations() {
  setResultsTitle('Gợi Ý Từ Trang Chủ', 0);
  elements.resultsList.innerHTML = '<p>Đang tải gợi ý...</p>';
  const data = await api('/api/recommendations');
  setStatus(data.status);
  setResultsTitle('Gợi Ý Từ Trang Chủ', data.items.length);
  renderResults(data.items);
}

async function loadNovel(url) {
  elements.detailEmpty.classList.add('hidden');
  elements.detailView.classList.remove('hidden');
  elements.novelTitle.textContent = 'Đang tải chi tiết...';
  elements.novelAuthor.textContent = '';
  elements.novelStats.innerHTML = renderStatPills(['Đang lấy dữ liệu']);
  elements.novelSummary.textContent = 'Đang đồng bộ tóm tắt và danh sách tập...';
  elements.novelSource.removeAttribute('href');
  elements.novelSource.textContent = 'Đang mở truyện';
  elements.coverImage.src = COVER_PLACEHOLDER;
  elements.volumeMeta.textContent = '';
  elements.volumeList.innerHTML = '';
  elements.downloadBtn.disabled = true;

  const data = await api(`/api/novel?url=${encodeURIComponent(url)}`);
  setStatus(data.status);
  renderNovelDetail(data.novel);
  renderResults(state.currentResults);
}

async function runSearch(query) {
  setResultsTitle(`Kết quả: ${query}`, 0);
  elements.resultsList.innerHTML = '<p>Đang tìm kiếm...</p>';
  const data = await api(`/api/search?q=${encodeURIComponent(query)}`);
  setStatus(data.status);
  setResultsTitle(`Kết quả: ${query}`, data.items.length);
  renderResults(data.items);
}

async function applyDns() {
  const profileId = elements.dnsSelect.value;
  const body = profileId === 'custom'
    ? {
        profileId: 'custom',
        servers: elements.customDnsInput.value.split(',').map(item => item.trim()).filter(Boolean)
      }
    : { profileId };

  const data = await api('/api/dns', {
    method: 'POST',
    body: JSON.stringify(body)
  });

  elements.dnsStatus.textContent = `DNS: ${data.current.label}`;
}

async function startDownload() {
  if (!state.currentNovel) {
    elements.taskSummary.textContent = 'Hãy chọn truyện trước khi tải.';
    elements.taskSummary.classList.add('error-text');
    return;
  }

  const selectedVolumeIndexes = getSelectedVolumeIndexes();
  if (selectedVolumeIndexes.length === 0) {
    elements.taskSummary.textContent = 'Hãy chọn ít nhất một tập.';
    elements.taskSummary.classList.add('error-text');
    return;
  }

  const data = await api('/api/download', {
    method: 'POST',
    body: JSON.stringify({
      url: state.currentNovel.sourceUrl,
      selectedVolumeIndexes,
      epubMode: elements.epubModeSelect.value
    })
  });

  renderTask(data.task);
  startTaskPolling(data.task.id);
}

function bindEvents() {
  elements.loadRecommendationsBtn.addEventListener('click', () => {
    loadRecommendations().catch(showInlineError);
  });

  elements.searchForm.addEventListener('submit', event => {
    event.preventDefault();
    const query = elements.searchInput.value.trim();
    if (!query) return;
    runSearch(query).catch(showInlineError);
  });

  elements.directUrlForm.addEventListener('submit', event => {
    event.preventDefault();
    const url = elements.directUrlInput.value.trim();
    if (!url) return;
    loadNovel(url).catch(showInlineError);
  });

  elements.resultsList.addEventListener('click', event => {
    const button = event.target.closest('.result-card');
    if (!button) return;

    const item = state.currentResults[Number.parseInt(button.dataset.index, 10)];
    if (!item) return;

    loadNovel(item.url).catch(showInlineError);
  });

  elements.applyDnsBtn.addEventListener('click', () => {
    applyDns().catch(showInlineError);
  });

  elements.selectAllVolumesBtn.addEventListener('click', () => {
    document.querySelectorAll('.volume-checkbox').forEach(input => {
      input.checked = true;
    });
    updateSelectionSummary();
  });

  elements.clearVolumesBtn.addEventListener('click', () => {
    document.querySelectorAll('.volume-checkbox').forEach(input => {
      input.checked = false;
    });
    updateSelectionSummary();
  });

  elements.volumeList.addEventListener('change', event => {
    if (!event.target.closest('.volume-checkbox')) return;
    updateSelectionSummary();
  });

  elements.downloadBtn.addEventListener('click', () => {
    startDownload().catch(showInlineError);
  });
}

function showInlineError(error) {
  elements.taskSummary.textContent = error.message || String(error);
  elements.taskSummary.classList.add('error-text');
  setTimeout(() => {
    elements.taskSummary.classList.remove('error-text');
  }, 2500);
}

async function bootstrap() {
  bindEvents();
  renderTask(null);
  updateDownloadButtonState();
  await loadStatus();
  await loadDnsProfiles();
  await loadRecommendations();
}

bootstrap().catch(showInlineError);
