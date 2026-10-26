'use strict';

const api = window.casaflix;

const els = {
  tabs: [...document.querySelectorAll('.tab')],
  searchInput: document.getElementById('searchInput'),
  refreshBtn: document.getElementById('refreshBtn'),
  folderBtn: document.getElementById('folderBtn'),
  libraryView: document.getElementById('libraryView'),
  discoverView: document.getElementById('discoverView'),
  libraryIntro: document.getElementById('libraryIntro'),
  librarySummary: document.getElementById('librarySummary'),
  rows: document.getElementById('rows'),
  loadingState: document.getElementById('loadingState'),
  emptyState: document.getElementById('emptyState'),
  emptyTitle: document.getElementById('emptyTitle'),
  emptyText: document.getElementById('emptyText'),
  emptyChooseBtn: document.getElementById('emptyChooseBtn'),
  emptyRefreshBtn: document.getElementById('emptyRefreshBtn'),
  discoverGrid: document.getElementById('discoverGrid'),
  offlineNotice: document.getElementById('offlineNotice'),
  linksHint: document.getElementById('linksHint'),
  statusCount: document.getElementById('statusCount'),
  statusFolder: document.getElementById('statusFolder'),
  netDot: document.getElementById('netDot'),
  netLabel: document.getElementById('netLabel'),
  playerView: document.getElementById('playerView'),
  playerBack: document.getElementById('playerBack'),
  playerTitle: document.getElementById('playerTitle'),
  playerSubtitle: document.getElementById('playerSubtitle'),
  playerVideo: document.getElementById('playerVideo'),
  playerNotice: document.getElementById('playerNotice'),
  toast: document.getElementById('toast'),
};

const appState = {
  initialized: false,
  busy: false,
  config: { videoRoot: null, folderName: null },
  library: null,
  progress: {},
  links: [],
  linksError: null,
  online: true,
  view: 'library',
  query: '',
  currentItem: null,
  playing: false,
  lastSavedAt: 0,
};

let toastTimer = null;
let playerNoticeTimer = null;
let searchTimer = null;
let networkTimer = null;

// ---------------------------------------------------------------------------
// Miniaturas: cola con IntersectionObserver
// ---------------------------------------------------------------------------

const THUMB_CONCURRENCY = 2;

const thumbQueue = {
  items: [],
  active: 0,
  queuedIds: new Set(),
  inFlight: new Map(),
  failed: new Set(),
  pendingCards: new WeakMap(),
};

const thumbObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const record = thumbQueue.pendingCards.get(entry.target);
      thumbObserver.unobserve(entry.target);
      if (!record) continue;
      thumbQueue.pendingCards.delete(entry.target);
      if (!record.img.isConnected) continue;
      if (record.item.thumbUrl) {
        setCardThumb(record.item, record);
      } else {
        enqueueThumbnail(record.item);
      }
    }
  },
  { root: null, rootMargin: '250px 320px', threshold: 0.01 },
);

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

init();

async function init() {
  bindEvents();
  els.loadingState.hidden = false;
  els.librarySummary.textContent = 'Preparando tu biblioteca…';

  if (!api) {
    showEmptyState({
      title: 'No se pudo cargar la aplicación',
      text: 'El puente seguro con el proceso principal no está disponible. Reinicia CasaFlix.',
      showRefresh: false,
      chooseLabel: 'Cerrar',
    });
    els.emptyChooseBtn.disabled = true;
    els.loadingState.hidden = true;
    return;
  }

  try {
    const snapshot = await api.getState();
    applySnapshot(snapshot);
  } catch (error) {
    console.error(error);
    els.loadingState.hidden = true;
    showEmptyState({
      title: 'No se pudo iniciar CasaFlix',
      text: 'Ha ocurrido un error al leer la biblioteca. Puedes volver a intentarlo.',
      showRefresh: true,
      chooseLabel: 'Elegir carpeta de vídeos',
    });
    showToast('No se pudo cargar la biblioteca.', 'error');
  }

  networkTimer = window.setInterval(() => {
    void refreshNetworkStatus();
  }, 20000);
}

function bindEvents() {
  for (const tab of els.tabs) {
    tab.addEventListener('click', () => setView(tab.dataset.view));
  }

  els.searchInput.addEventListener('input', () => {
    const value = els.searchInput.value;
    if (value.trim() && appState.view !== 'library') setView('library');
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      appState.query = value;
      renderLibrary();
    }, 110);
  });

  els.folderBtn.addEventListener('click', () => void chooseFolder());
  els.emptyChooseBtn.addEventListener('click', () => {
    if (api && !els.emptyChooseBtn.disabled) void chooseFolder();
  });
  els.refreshBtn.addEventListener('click', () => void refreshLibrary());
  els.emptyRefreshBtn.addEventListener('click', () => void refreshLibrary());

  els.playerBack.addEventListener('click', closePlayer);
  els.playerVideo.addEventListener('timeupdate', () => saveCurrentProgress(false));
  els.playerVideo.addEventListener('pause', () => saveCurrentProgress(true));
  els.playerVideo.addEventListener('error', () => {
    if (appState.playing) {
      showPlayerNotice('No se pudo reproducir este vídeo. Comprueba que el archivo sigue disponible.');
    }
  });
  els.playerVideo.addEventListener('ended', handlePlaybackEnded);

  document.addEventListener('keydown', (event) => {
    if (!els.playerView.hidden) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePlayer();
      }
      return;
    }

    const target = event.target;
    const isEditable =
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable);

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      els.searchInput.focus();
      els.searchInput.select();
      return;
    }

    if (event.key === '/' && !isEditable) {
      event.preventDefault();
      els.searchInput.focus();
    }
  });

  window.addEventListener('online', () => void refreshNetworkStatus(true));
  window.addEventListener('offline', () => void refreshNetworkStatus(true));
  window.addEventListener('beforeunload', () => saveCurrentProgress(true));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) saveCurrentProgress(true);
  });
}

// ---------------------------------------------------------------------------
// Datos y vistas
// ---------------------------------------------------------------------------

function applySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;

  appState.config = snapshot.config || { videoRoot: null, folderName: null };
  appState.library = snapshot.library || null;
  appState.progress =
    snapshot.progress && typeof snapshot.progress === 'object'
      ? snapshot.progress
      : {};
  appState.links = Array.isArray(snapshot.links) ? snapshot.links : [];
  appState.linksError = snapshot.linksError || null;
  appState.online = snapshot.online !== false;
  appState.initialized = true;

  els.loadingState.hidden = true;
  updateStatus();
  updateOnlineUi();
  renderLibrary();
  renderDiscover();
}

function setView(view) {
  if (view !== 'library' && view !== 'discover') return;
  appState.view = view;

  els.libraryView.hidden = view !== 'library';
  els.discoverView.hidden = view !== 'discover';

  for (const tab of els.tabs) {
    const isActive = tab.dataset.view === view;
    tab.classList.toggle('is-active', isActive);
    if (isActive) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }

  if (view === 'discover') {
    void refreshLinks();
    void refreshNetworkStatus();
  }
}

function allItems() {
  if (!appState.library || !Array.isArray(appState.library.categories)) return [];
  return appState.library.categories.flatMap((category) =>
    Array.isArray(category.items) ? category.items : [],
  );
}

function progressFor(id) {
  const progress = appState.progress[id];
  if (!progress || !Number.isFinite(progress.position)) return null;
  if (progress.duration > 0 && progress.position >= progress.duration - 8) return null;
  return progress;
}

function continueWatchingItems() {
  return allItems()
    .map((item) => ({ item, progress: progressFor(item.id) }))
    .filter(({ progress }) => progress && progress.position >= 5)
    .sort((a, b) => (b.progress.updatedAt || 0) - (a.progress.updatedAt || 0))
    .slice(0, 20);
}

function renderLibrary() {
  if (!appState.initialized) return;

  // Las tarjetas se reconstruyen por completo en cada render; se reinicia el
  // observador para no retener nodos antiguos.
  thumbObserver.disconnect();
  thumbQueue.pendingCards = new WeakMap();

  const library = appState.library;
  const configured = Boolean(appState.config.videoRoot);
  const items = allItems();
  const query = appState.query.trim();

  els.rows.textContent = '';
  els.rows.hidden = false;

  if (!configured) {
    els.librarySummary.textContent =
      'Elige una carpeta para empezar. Tus vídeos no salen de este equipo.';
    showEmptyState({
      title: 'Tu cine, a un clic',
      text: 'Elige la carpeta donde guardas tus vídeos. Cada subcarpeta se convertirá en una fila y los vídeos sueltos aparecerán en «Sin categoría».',
      showRefresh: false,
      chooseLabel: 'Elegir carpeta de vídeos',
    });
    updateStatus();
    return;
  }

  if (!library || library.error) {
    const message =
      (library && library.error) || 'No se pudo leer la carpeta de vídeos.';
    els.librarySummary.textContent = message;
    showEmptyState({
      title: 'La carpeta no está disponible',
      text: `${message} Puedes volver a intentarlo o elegir otra carpeta.`,
      showRefresh: true,
      chooseLabel: 'Elegir otra carpeta',
    });
    updateStatus();
    return;
  }

  if (items.length === 0) {
    els.librarySummary.textContent = `No hay vídeos compatibles en «${library.folderName || 'la carpeta'}».`;
    showEmptyState({
      title: 'Esta carpeta está vacía',
      text: 'No se han encontrado archivos MP4, WebM o M4V. Añade vídeos a la carpeta o elige otra distinta.',
      showRefresh: true,
      chooseLabel: 'Elegir otra carpeta',
    });
    updateStatus();
    return;
  }

  els.emptyState.hidden = true;
  const categoryCount = library.categories.length;
  const warnings = library.warnings
    ? ` · ${library.warnings} ${library.warnings === 1 ? 'aviso' : 'avisos'} de lectura`
    : '';
  const baseMeta = `${countLabel(items.length, 'vídeo', 'vídeos')} · ${countLabel(
    categoryCount,
    'categoría',
    'categorías',
  )}${warnings}`;

  if (query) {
    const normalizedQuery = normalizeText(query);
    const matches = items.filter((item) =>
      normalizeText(item.title).includes(normalizedQuery),
    );
    els.librarySummary.textContent = `${countLabel(
      matches.length,
      'resultado',
      'resultados',
    )} para «${query}» · ${library.folderName || ''}`;

    if (matches.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-inline';
      const title = document.createElement('h2');
      title.textContent = 'Sin resultados';
      const text = document.createElement('p');
      text.textContent = `No hay títulos que coincidan con «${query}». Prueba con otras palabras.`;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'text-button';
      button.textContent = 'Limpiar búsqueda';
      button.addEventListener('click', clearSearch);
      empty.append(title, text, button);
      els.rows.append(empty);
      updateStatus();
      return;
    }

    els.rows.append(buildRow('Resultados', matches, { showCategory: true }));
    updateStatus();
    return;
  }

  els.librarySummary.textContent = `${baseMeta} · ${library.folderName || ''}`;

  const continueItems = continueWatchingItems();
  if (continueItems.length > 0) {
    els.rows.append(
      buildRow(
        'Continuar viendo',
        continueItems.map((entry) => entry.item),
        {
          progressById: new Map(
            continueItems.map((entry) => [entry.item.id, entry.progress]),
          ),
          continueRow: true,
        },
      ),
    );
  }

  for (const category of library.categories) {
    if (!category.items || category.items.length === 0) continue;
    els.rows.append(buildRow(category.name, category.items));
  }

  updateStatus();
}

function clearSearch() {
  els.searchInput.value = '';
  appState.query = '';
  renderLibrary();
  els.searchInput.focus();
}

function buildRow(title, items, options = {}) {
  const row = document.createElement('section');
  row.className = 'row';
  row.setAttribute('aria-label', title);

  const head = document.createElement('div');
  head.className = 'row-head';

  const heading = document.createElement('h2');
  heading.className = 'row-title';
  heading.textContent = title;

  const count = document.createElement('span');
  count.className = 'row-count';
  count.textContent = String(items.length);

  const arrows = document.createElement('div');
  arrows.className = 'row-arrows';

  const prev = createArrowButton('left', `Desplazar ${title} a la izquierda`);
  const next = createArrowButton('right', `Desplazar ${title} a la derecha`);
  arrows.append(prev, next);

  head.append(heading, count, arrows);

  const track = document.createElement('div');
  track.className = 'row-track';
  track.tabIndex = -1;

  for (const item of items) {
    const progress = options.progressById
      ? options.progressById.get(item.id) || null
      : progressFor(item.id);
    track.append(
      createCard(item, {
        progress,
        showCategory: Boolean(options.showCategory),
        continueRow: Boolean(options.continueRow),
      }),
    );
  }

  row.append(head, track);

  const updateArrows = () => {
    const maxScroll = track.scrollWidth - track.clientWidth;
    prev.disabled = track.scrollLeft <= 2;
    next.disabled = maxScroll <= 2 || track.scrollLeft >= maxScroll - 2;
  };

  prev.addEventListener('click', () => {
    track.scrollBy({ left: -track.clientWidth * 0.82, behavior: 'smooth' });
  });
  next.addEventListener('click', () => {
    track.scrollBy({ left: track.clientWidth * 0.82, behavior: 'smooth' });
  });
  track.addEventListener('scroll', updateArrows, { passive: true });
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(updateArrows).observe(track);
  }
  window.requestAnimationFrame(updateArrows);

  return row;
}

function createArrowButton(direction, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'row-arrow';
  button.setAttribute('aria-label', label);
  button.innerHTML =
    direction === 'left'
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 5 7.5 12l7 7" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return button;
}

function createCard(item, options = {}) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'card';
  card.dataset.id = item.id;
  card.setAttribute('aria-label', `Reproducir ${item.title}`);

  const media = document.createElement('div');
  media.className = 'card-media';

  const placeholder = document.createElement('div');
  placeholder.className = `card-placeholder tone-${toneFor(item.id)}`;

  const initials = document.createElement('span');
  initials.className = 'card-initials';
  initials.textContent = titleInitials(item.title);
  placeholder.append(initials);

  const img = document.createElement('img');
  img.className = 'card-img';
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';
  img.dataset.itemId = item.id;

  let usingPoster = false;
  let usingThumb = false;

  if (item.posterUrl) {
    usingPoster = true;
    img.dataset.source = 'poster';
    img.src = item.posterUrl;
    img.hidden = false;
    img.addEventListener('load', () => {
      placeholder.hidden = true;
    });
    img.addEventListener('error', () => {
      img.hidden = true;
      placeholder.hidden = false;
      img.dataset.source = 'none';
      requestThumb({ card, item, img, placeholder });
    });
  } else if (item.thumbUrl) {
    usingThumb = true;
    img.dataset.source = 'thumb';
    img.dataset.thumbState = 'done';
    img.src = item.thumbUrl;
    img.hidden = false;
    img.addEventListener('load', () => {
      placeholder.hidden = true;
    });
    img.addEventListener('error', () => {
      img.hidden = true;
      placeholder.hidden = false;
      img.dataset.thumbState = 'failed';
    });
  } else {
    img.hidden = true;
    if (!thumbQueue.failed.has(item.id)) {
      thumbQueue.pendingCards.set(card, { card, item, img, placeholder });
      thumbObserver.observe(card);
    }
  }

  media.append(placeholder, img);

  const play = document.createElement('span');
  play.className = 'card-play';
  play.innerHTML =
    '<span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.2v13.6L19 12z" fill="currentColor"/></svg></span>';
  media.append(play);

  const progress = options.progress || null;
  if (progress) {
    const percent =
      progress.duration > 0
        ? Math.max(1, Math.min(100, Math.round((progress.position / progress.duration) * 100)))
        : 0;

    if (percent > 0) {
      const tag = document.createElement('span');
      tag.className = 'card-tag';
      tag.textContent = `Continuar · ${percent} %`;
      media.append(tag);

      const bar = document.createElement('span');
      bar.className = 'card-progress';
      const fill = document.createElement('span');
      fill.style.width = `${percent}%`;
      bar.append(fill);
      media.append(bar);
    } else {
      const tag = document.createElement('span');
      tag.className = 'card-tag';
      tag.textContent = 'Continuar';
      media.append(tag);
    }
  }

  const body = document.createElement('div');
  body.className = 'card-body';

  const title = document.createElement('p');
  title.className = 'card-title';
  title.textContent = item.title;

  const meta = document.createElement('p');
  meta.className = 'card-meta';
  if (progress) {
    const parts = [];
    if (progress.duration > 0) {
      parts.push(
        `${formatTime(progress.position)} de ${formatTime(progress.duration)}`,
      );
    } else {
      parts.push(`Visto hasta ${formatTime(progress.position)}`);
    }
    if (options.showCategory && item.category) parts.push(item.category);
    meta.textContent = parts.join(' · ');
  } else {
    meta.textContent = item.category || '';
  }

  body.append(title, meta);
  card.append(media, body);

  card.addEventListener('click', () => openPlayer(item));

  // Evita que el cargador nativo de imágenes y el observador de miniaturas
  // se activen con imágenes que ya tienen origen definitivo.
  if (usingPoster || usingThumb) {
    img.dataset.resolved = '1';
  }

  return card;
}

function requestThumb(record) {
  if (record.item.thumbUrl) {
    setCardThumb(record.item, record);
    return;
  }
  if (thumbQueue.failed.has(record.item.id)) return;
  enqueueThumbnail(record.item);
}

function enqueueThumbnail(item) {
  if (!item || !item.id || item.thumbUrl) return;
  if (thumbQueue.failed.has(item.id)) return;
  if (thumbQueue.inFlight.has(item.id) || thumbQueue.queuedIds.has(item.id)) {
    return;
  }

  thumbQueue.queuedIds.add(item.id);
  thumbQueue.items.push(item);
  pumpThumbQueue();
}

function pumpThumbQueue() {
  while (thumbQueue.active < THUMB_CONCURRENCY && thumbQueue.items.length > 0) {
    const item = thumbQueue.items.shift();
    thumbQueue.queuedIds.delete(item.id);
    if (!item || item.thumbUrl || thumbQueue.failed.has(item.id)) continue;

    thumbQueue.active += 1;
    const task = generateThumbnail(item)
      .then((url) => {
        if (!url) return;
        item.thumbUrl = url;
        applyThumbToDom(item);
      })
      .catch((error) => {
        console.warn('[CasaFlix] No se pudo crear la miniatura:', error.message);
        thumbQueue.failed.add(item.id);
      })
      .finally(() => {
        thumbQueue.inFlight.delete(item.id);
        thumbQueue.active -= 1;
        pumpThumbQueue();
      });

    thumbQueue.inFlight.set(item.id, task);
  }
}

async function generateThumbnail(item) {
  const video = document.createElement('video');
  video.className = 'thumb-work';
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = item.mediaUrl;
  document.body.append(video);

  try {
    video.load();
    if (video.readyState < 2) {
      await waitForMediaEvent(video, 'loadeddata', 15000);
    }
    if (!video.videoWidth || !video.videoHeight) {
      throw new Error('El vídeo no tiene imagen decodificable.');
    }

    let target = 1;
    if (Number.isFinite(video.duration) && video.duration > 0) {
      target = Math.min(
        Math.max(video.duration * 0.18, 0.3),
        Math.max(video.duration - 0.15, 0.3),
        20,
      );
    }
    await seekVideo(video, target);

    const width = 480;
    const height = 270;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No se pudo crear el lienzo.');

    context.fillStyle = '#101620';
    context.fillRect(0, 0, width, height);

    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    const scale = Math.max(width / sourceWidth, height / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    context.drawImage(
      video,
      (width - drawWidth) / 2,
      (height - drawHeight) / 2,
      drawWidth,
      drawHeight,
    );

    const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
    if (!dataUrl.startsWith('data:image/jpeg')) {
      throw new Error('No se pudo generar la imagen.');
    }

    const result = await api.saveThumbnail(item.id, dataUrl);
    if (!result || !result.ok || !result.url) {
      throw new Error((result && result.error) || 'No se pudo guardar la miniatura.');
    }
    return result.url;
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
  }
}

function waitForMediaEvent(target, eventName, timeout) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('Tiempo de espera agotado al leer el vídeo.'));
    }, timeout);

    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('No se pudo leer el vídeo.'));
    };
    function cleanup() {
      window.clearTimeout(timer);
      target.removeEventListener(eventName, onEvent);
      target.removeEventListener('error', onError);
    }

    target.addEventListener(eventName, onEvent, { once: true });
    target.addEventListener('error', onError, { once: true });
  });
}

async function seekVideo(video, target) {
  if (!Number.isFinite(target) || target < 0) return;
  if (Math.abs(video.currentTime - target) < 0.05 && video.readyState >= 2) return;

  const seeked = waitForMediaEvent(video, 'seeked', 4000).catch(() => {});
  try {
    video.currentTime = target;
  } catch {
    return;
  }
  await seeked;

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = window.setTimeout(finish, 250);
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(() => {
        window.clearTimeout(timer);
        finish();
      });
    }
  });
}

function applyThumbToDom(item) {
  if (!item.thumbUrl) return;
  const images = document.querySelectorAll(`.card-img[data-item-id="${item.id}"]`);
  for (const img of images) {
    if (img.dataset.source === 'poster') continue;
    const media = img.closest('.card-media');
    const placeholder = media ? media.querySelector('.card-placeholder') : null;
    img.dataset.source = 'thumb';
    img.dataset.thumbState = 'done';
    img.hidden = false;
    img.src = item.thumbUrl;
    if (placeholder) {
      placeholder.hidden = false;
      img.addEventListener(
        'load',
        () => {
          placeholder.hidden = true;
        },
        { once: true },
      );
    }
    img.addEventListener(
      'error',
      () => {
        img.hidden = true;
        img.dataset.thumbState = 'failed';
        if (placeholder) placeholder.hidden = false;
      },
      { once: true },
    );
  }
}

function setCardThumb(item, record) {
  if (!item.thumbUrl || !record || !record.img) return;
  const { img, placeholder } = record;
  img.dataset.source = 'thumb';
  img.dataset.thumbState = 'done';
  placeholder.hidden = false;
  img.hidden = false;
  img.src = item.thumbUrl;
  img.addEventListener(
    'load',
    () => {
      placeholder.hidden = true;
    },
    { once: true },
  );
}

// ---------------------------------------------------------------------------
// Selección de carpeta y actualización
// ---------------------------------------------------------------------------

async function chooseFolder() {
  if (!api || appState.busy) return;
  setBusy(true, 'Esperando carpeta…');
  try {
    const result = await api.chooseFolder();
    if (result && result.canceled) return;
    if (result && result.snapshot) {
      applySnapshot(result.snapshot);
      const count = result.snapshot.library ? result.snapshot.library.itemCount : 0;
      showToast(
        count > 0
          ? `Biblioteca lista: ${countLabel(count, 'vídeo', 'vídeos')}.`
          : 'La carpeta no contiene vídeos compatibles.',
      );
    }
  } catch (error) {
    console.error(error);
    showToast('No se pudo cambiar la carpeta.', 'error');
  } finally {
    setBusy(false);
  }
}

async function refreshLibrary() {
  if (!api || appState.busy) return;
  setBusy(true, 'Escaneando…');
  try {
    const snapshot = await api.refreshLibrary();
    applySnapshot(snapshot);
    if (snapshot.library && snapshot.library.error) {
      showToast(snapshot.library.error, 'error');
    } else {
      const count = snapshot.library ? snapshot.library.itemCount : 0;
      showToast(`Biblioteca actualizada: ${countLabel(count, 'vídeo', 'vídeos')}.`);
    }
  } catch (error) {
    console.error(error);
    showToast('No se pudo volver a escanear la carpeta.', 'error');
  } finally {
    setBusy(false);
  }
}

function setBusy(busy, message) {
  appState.busy = busy;
  els.refreshBtn.classList.toggle('is-busy', busy);
  els.refreshBtn.disabled = busy;
  els.folderBtn.disabled = busy;
  els.emptyChooseBtn.disabled = busy;
  els.emptyRefreshBtn.disabled = busy;
  if (busy) {
    els.refreshBtn.setAttribute('aria-busy', 'true');
    if (message) els.statusCount.textContent = message;
  } else {
    els.refreshBtn.removeAttribute('aria-busy');
    updateStatus();
  }
}

// ---------------------------------------------------------------------------
// Reproductor
// ---------------------------------------------------------------------------

function openPlayer(item) {
  if (!item || appState.playing) return;

  appState.currentItem = item;
  appState.playing = true;
  appState.lastSavedAt = 0;

  els.playerTitle.textContent = item.title;
  els.playerSubtitle.textContent = `${item.category} · ${item.extension
    .replace('.', '')
    .toUpperCase()}`;
  els.playerNotice.hidden = true;
  window.clearTimeout(playerNoticeTimer);

  els.playerView.hidden = false;
  document.body.classList.add('is-playing');

  const video = els.playerVideo;
  video.src = item.mediaUrl;
  video.load();

  const saved = appState.progress[item.id];
  const canResume =
    saved &&
    Number.isFinite(saved.position) &&
    saved.position >= 5 &&
    (!saved.duration || saved.position < saved.duration - 8);

  video.onloadedmetadata = () => {
    if (canResume) {
      let target = saved.position;
      if (Number.isFinite(video.duration) && video.duration > 0) {
        target = Math.min(saved.position, Math.max(video.duration - 2, 0));
      }
      try {
        video.currentTime = target;
        showPlayerNotice(`Reanudando desde ${formatTime(target)}.`, 6000);
      } catch {
        // Si el archivo no permite buscar, empieza desde el principio.
      }
    }
    video.play().catch(() => {
      // Los controles nativos permiten iniciar la reproducción manualmente.
    });
  };

  video.focus();
}

function handlePlaybackEnded() {
  const item = appState.currentItem;
  if (!item) return;
  delete appState.progress[item.id];
  if (api) api.clearProgress(item.id).catch(() => {});
  showPlayerNotice('Fin del vídeo. La próxima vez empezará desde el principio.', 7000);
}

function saveCurrentProgress(force) {
  const item = appState.currentItem;
  if (!appState.playing || !item) return;

  const video = els.playerVideo;
  const position = video.currentTime;
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  if (!Number.isFinite(position) || position < 0) return;

  const now = Date.now();
  if (!force && now - appState.lastSavedAt < 4500) return;
  appState.lastSavedAt = now;

  if (duration > 0 && position >= duration * 0.98) {
    delete appState.progress[item.id];
    if (api) api.saveProgress(item.id, position, duration).catch(() => {});
    return;
  }

  appState.progress[item.id] = {
    position,
    duration,
    updatedAt: now,
  };
  if (api) api.saveProgress(item.id, position, duration).catch(() => {});
}

function closePlayer() {
  if (!appState.playing) return;

  saveCurrentProgress(true);

  const item = appState.currentItem;
  const video = els.playerVideo;
  appState.playing = false;
  appState.currentItem = null;

  video.onloadedmetadata = null;
  video.ontimeupdate = null;
  video.onpause = null;
  video.onended = null;
  video.onerror = null;
  video.pause();
  video.removeAttribute('src');
  video.load();

  els.playerView.hidden = true;
  els.playerNotice.hidden = true;
  window.clearTimeout(playerNoticeTimer);
  document.body.classList.remove('is-playing');

  renderLibrary();

  if (item) {
    const card = els.rows.querySelector(`.card[data-id="${item.id}"]`);
    if (card) card.focus({ preventScroll: true });
  }
}

function showPlayerNotice(message, duration = 5000) {
  els.playerNotice.textContent = message;
  els.playerNotice.hidden = false;
  window.clearTimeout(playerNoticeTimer);
  playerNoticeTimer = window.setTimeout(() => {
    els.playerNotice.hidden = true;
  }, duration);
}

// ---------------------------------------------------------------------------
// Descubrir y conexión
// ---------------------------------------------------------------------------

async function refreshLinks() {
  if (!api) return;
  try {
    const result = await api.getLinks();
    if (!result) return;
    appState.links = Array.isArray(result.links) ? result.links : [];
    appState.linksError = result.error || null;
    renderDiscover();
  } catch {
    // Conserva los enlaces ya cargados.
  }
}

function renderDiscover() {
  els.discoverGrid.textContent = '';

  if (appState.linksError) {
    const notice = document.createElement('div');
    notice.className = 'empty-inline';
    const title = document.createElement('h2');
    title.textContent = 'No se pudieron cargar los enlaces';
    const text = document.createElement('p');
    text.textContent = appState.linksError;
    notice.append(title, text);
    els.discoverGrid.append(notice);
  }

  if (appState.links.length === 0) {
    if (!appState.linksError) {
      const notice = document.createElement('div');
      notice.className = 'empty-inline';
      const title = document.createElement('h2');
      title.textContent = 'Sin enlaces disponibles';
      const text = document.createElement('p');
      text.textContent =
        'Añade enlaces a links.json para verlos aquí. El archivo se puede editar con cualquier editor de texto.';
      notice.append(title, text);
      els.discoverGrid.append(notice);
    }
    updateOnlineUi();
    return;
  }

  for (const link of appState.links) {
    els.discoverGrid.append(createLinkCard(link));
  }

  els.linksHint.innerHTML =
    `¿Quieres cambiar esta selección? Edita <code>links.json</code> y vuelve a esta pestaña. ` +
    'CasaFlix no aloja ni reproduce contenido de terceros.';
  updateOnlineUi();
}

function createLinkCard(link) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'link-card';
  card.dataset.url = link.url;
  card.setAttribute('aria-label', `Abrir ${link.name} en el navegador`);

  const top = document.createElement('div');
  top.className = 'link-top';

  const tile = document.createElement('span');
  tile.className = `link-tile tone-${toneFor(link.name)}`;
  tile.textContent = (link.name.trim()[0] || '?').toUpperCase();

  const headings = document.createElement('div');
  headings.style.minWidth = '0';
  const name = document.createElement('h2');
  name.className = 'link-name';
  name.textContent = link.name;
  const host = document.createElement('p');
  host.className = 'link-host';
  host.textContent = hostLabel(link.url);
  headings.append(name, host);
  top.append(tile, headings);

  const description = document.createElement('p');
  description.className = 'link-description';
  description.textContent =
    link.description || 'Catálogo gratuito disponible en el navegador.';

  const foot = document.createElement('span');
  foot.className = 'link-foot';
  foot.innerHTML =
    'Abrir en el navegador <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5h10v10M19 5 8 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  card.append(top, description, foot);
  card.addEventListener('click', () => void openLink(link));

  return card;
}

async function openLink(link) {
  if (!appState.online) {
    showToast('Sin conexión a internet. Tu biblioteca local sigue disponible.', 'error');
    return;
  }
  try {
    const result = await api.openExternal(link.url);
    if (!result || !result.ok) {
      showToast((result && result.error) || 'No se pudo abrir el navegador.', 'error');
    }
  } catch {
    showToast('No se pudo abrir el navegador.', 'error');
  }
}

async function refreshNetworkStatus(notify = false) {
  if (!api) return;
  try {
    const result = await api.networkStatus();
    const online = Boolean(result && result.online);
    const changed = online !== appState.online;
    appState.online = online;
    updateOnlineUi();
    if (changed && notify && !online && appState.view === 'discover') {
      showToast('Has perdido la conexión a internet.', 'error');
    }
  } catch {
    // Mantiene el último estado conocido.
  }
}

function updateOnlineUi() {
  els.netDot.classList.toggle('is-online', appState.online);
  els.netDot.classList.toggle('is-offline', !appState.online);
  els.netLabel.textContent = appState.online ? 'En línea' : 'Sin conexión';
  els.offlineNotice.hidden = appState.online;

  for (const card of els.discoverGrid.querySelectorAll('.link-card')) {
    card.classList.toggle('is-disabled', !appState.online);
    card.setAttribute('aria-disabled', String(!appState.online));
  }
}

// ---------------------------------------------------------------------------
// Estado, textos y avisos
// ---------------------------------------------------------------------------

function updateStatus() {
  const library = appState.library;
  const items = allItems();

  if (!appState.config.videoRoot) {
    els.statusCount.textContent = 'Sin biblioteca';
    els.statusFolder.textContent = 'Elige una carpeta para empezar';
    return;
  }

  if (appState.busy) return;

  if (library && library.error) {
    els.statusCount.textContent = 'Carpeta no disponible';
    els.statusFolder.textContent = library.folderName || '';
    return;
  }

  els.statusCount.textContent = countLabel(items.length, 'vídeo', 'vídeos');
  els.statusFolder.textContent = library && library.folderName
    ? `Carpeta: ${library.folderName}`
    : '';
  if (library && library.warnings > 0) {
    els.statusFolder.textContent += ` · ${library.warnings} ${library.warnings === 1 ? 'aviso' : 'avisos'} de lectura`;
  }
}

function showEmptyState({ title, text, showRefresh, chooseLabel }) {
  els.emptyTitle.textContent = title;
  els.emptyText.textContent = text;
  els.emptyRefreshBtn.hidden = !showRefresh;
  if (chooseLabel) els.emptyChooseBtn.textContent = chooseLabel;
  els.emptyState.hidden = false;
  els.rows.hidden = true;
}

function showToast(message, type = 'info', duration = 3800) {
  window.clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.toggle('is-error', type === 'error');
  els.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, duration);
}

// ---------------------------------------------------------------------------
// Utilidades de formato
// ---------------------------------------------------------------------------

function normalizeText(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function titleInitials(title) {
  const words = String(title)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

function toneFor(value) {
  let sum = 0;
  for (const char of String(value)) sum += char.charCodeAt(0);
  return sum % 8;
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function countLabel(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function hostLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
