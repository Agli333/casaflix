'use strict';

const api = window.casaflix;

const els = {
  tabs: [...document.querySelectorAll('.tab')],
  searchInput: document.getElementById('searchInput'),
  refreshBtn: document.getElementById('refreshBtn'),
  folderBtn: document.getElementById('folderBtn'),
  libraryView: document.getElementById('libraryView'),
  discoverView: document.getElementById('discoverView'),
  seriesDetailView: document.getElementById('seriesDetailView'),
  libraryEyebrow: document.getElementById('libraryEyebrow'),
  libraryTitle: document.getElementById('libraryTitle'),
  librarySummary: document.getElementById('librarySummary'),
  structureNotice: document.getElementById('structureNotice'),
  structureNoticeText: document.getElementById('structureNoticeText'),
  structureNoticeClose: document.getElementById('structureNoticeClose'),
  rows: document.getElementById('rows'),
  loadingState: document.getElementById('loadingState'),
  emptyState: document.getElementById('emptyState'),
  emptyTitle: document.getElementById('emptyTitle'),
  emptyText: document.getElementById('emptyText'),
  emptyHint: document.getElementById('emptyHint'),
  emptyChooseBtn: document.getElementById('emptyChooseBtn'),
  emptyRefreshBtn: document.getElementById('emptyRefreshBtn'),
  seriesDetailBack: document.getElementById('seriesDetailBack'),
  seriesDetailPoster: document.getElementById('seriesDetailPoster'),
  seriesDetailTitle: document.getElementById('seriesDetailTitle'),
  seriesDetailMeta: document.getElementById('seriesDetailMeta'),
  detailSeasons: document.getElementById('detailSeasons'),
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
  playerNext: document.getElementById('playerNext'),
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
  durations: {},
  links: [],
  linksError: null,
  online: true,
  view: 'movies',
  detailSeriesId: null,
  query: '',
  structureNoticeDismissed: false,
  currentItem: null,
  playing: false,
  playbackEnded: false,
  lastSavedAt: 0,
  playQueue: [],
  playIndex: -1,
};

let toastTimer = null;
let playerNoticeTimer = null;
let searchTimer = null;
let networkTimer = null;

// ---------------------------------------------------------------------------
// Miniaturas: cola compartida con IntersectionObserver
// ---------------------------------------------------------------------------

const MEDIA_CONCURRENCY = 2;

const thumbQueue = {
  items: [],
  active: 0,
  queuedIds: new Set(),
  inFlight: new Map(),
  failed: new Set(),
  callbacks: new Map(),
};

const durationQueue = {
  items: [],
  active: 0,
  queuedIds: new Set(),
  inFlight: new Map(),
  failed: new Set(),
  callbacks: new Map(),
};

let thumbObserverJobs = new WeakMap();
let durationObserverJobs = new WeakMap();

const thumbObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const job = thumbObserverJobs.get(entry.target);
      thumbObserver.unobserve(entry.target);
      if (!job || !job.img.isConnected) continue;
      job.start();
    }
  },
  { root: null, rootMargin: '250px 320px', threshold: 0.01 },
);

const durationObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const job = durationObserverJobs.get(entry.target);
      durationObserver.unobserve(entry.target);
      if (!job || !job.element.isConnected) continue;
      job.start();
    }
  },
  { root: null, rootMargin: '180px', threshold: 0.01 },
);

function resetObservers() {
  thumbObserver.disconnect();
  durationObserver.disconnect();
  thumbObserverJobs = new WeakMap();
  durationObserverJobs = new WeakMap();
}

function observeThumb(element, job) {
  thumbObserverJobs.set(element, job);
  thumbObserver.observe(element);
}

function observeDuration(element, item) {
  if (!item || !item.id || itemDuration(item.id)) return;
  durationObserverJobs.set(element, {
    element,
    start: () => requestDuration(item),
  });
  durationObserver.observe(element);
}

function resetMediaQueues() {
  // Conserva las tareas en curso, pero descarta las que aún no han empezado.
  thumbQueue.items.length = 0;
  thumbQueue.queuedIds.clear();
  durationQueue.items.length = 0;
  durationQueue.queuedIds.clear();
}

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
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      appState.query = value;
      if (value.trim() && appState.view === 'discover') {
        setView('movies');
      }
      if (appState.detailSeriesId) {
        appState.detailSeriesId = null;
        els.seriesDetailView.hidden = true;
        els.libraryView.hidden = false;
      }
      renderCurrentView();
    }, 110);
  });

  els.folderBtn.addEventListener('click', () => void chooseFolder());
  els.emptyChooseBtn.addEventListener('click', () => {
    if (api && !els.emptyChooseBtn.disabled) void chooseFolder();
  });
  els.refreshBtn.addEventListener('click', () => void refreshLibrary());
  els.emptyRefreshBtn.addEventListener('click', () => void refreshLibrary());

  els.structureNoticeClose.addEventListener('click', () => {
    appState.structureNoticeDismissed = true;
    els.structureNotice.hidden = true;
  });

  els.seriesDetailBack.addEventListener('click', backToSeries);

  els.playerBack.addEventListener('click', closePlayer);
  els.playerNext.addEventListener('click', playNextEpisode);
  els.playerVideo.addEventListener('timeupdate', () => saveCurrentProgress(false));
  els.playerVideo.addEventListener('play', () => {
    appState.playbackEnded = false;
  });
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
  appState.durations =
    snapshot.durations && typeof snapshot.durations === 'object'
      ? snapshot.durations
      : {};
  appState.links = Array.isArray(snapshot.links) ? snapshot.links : [];
  appState.linksError = snapshot.linksError || null;
  appState.online = snapshot.online !== false;
  appState.initialized = true;

  if (appState.detailSeriesId && !findSeries(appState.detailSeriesId)) {
    appState.detailSeriesId = null;
    els.seriesDetailView.hidden = true;
  }

  els.loadingState.hidden = true;
  updateStatus();
  updateOnlineUi();
  renderCurrentView();
  renderDiscover();
}

function setView(view) {
  if (view !== 'movies' && view !== 'series' && view !== 'discover') return;
  appState.view = view;
  appState.detailSeriesId = null;

  els.libraryView.hidden = view === 'discover';
  els.seriesDetailView.hidden = true;
  els.discoverView.hidden = view !== 'discover';

  for (const tab of els.tabs) {
    const isActive = tab.dataset.view === view;
    tab.classList.toggle('is-active', isActive);
    if (isActive) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }

  updateSearchPlaceholder();

  if (view === 'discover') {
    void refreshLinks();
    void refreshNetworkStatus();
    renderDiscover();
  } else {
    renderLibrary();
  }

  const main = document.getElementById('main');
  if (main) main.scrollTop = 0;
}

function renderCurrentView() {
  if (!appState.initialized) return;
  if (appState.detailSeriesId) {
    renderSeriesDetail();
    return;
  }
  if (appState.view === 'discover') {
    renderDiscover();
    return;
  }
  renderLibrary();
}

function updateSearchPlaceholder() {
  els.searchInput.placeholder =
    appState.view === 'series'
      ? 'Buscar en Series…'
      : appState.view === 'discover'
        ? 'Buscar por título…'
        : 'Buscar en Películas…';
}

function findSeries(seriesId) {
  return allSeries().find((series) => series.id === seriesId) || null;
}

function allMovies() {
  if (!appState.library || !Array.isArray(appState.library.movies)) return [];
  return appState.library.movies;
}

function allSeries() {
  if (!appState.library || !Array.isArray(appState.library.series)) return [];
  return appState.library.series;
}

function allEpisodes(seriesList = allSeries()) {
  const episodes = [];
  for (const series of seriesList) {
    for (const season of series.seasons || []) {
      for (const episode of season.episodes || []) {
        episodes.push(episode);
      }
    }
  }
  return episodes;
}

function episodesOfSeries(seriesId) {
  const series = findSeries(seriesId);
  if (!series) return [];
  return allEpisodes([series]);
}

function progressFor(id) {
  const progress = appState.progress[id];
  if (!progress || !Number.isFinite(progress.position)) return null;
  if (progress.duration > 0 && progress.position >= progress.duration - 8) return null;
  return progress;
}

function continueEntries(kind) {
  if (kind === 'movies') {
    return allMovies()
      .map((item) => ({ item, progress: progressFor(item.id) }))
      .filter(({ progress }) => progress && progress.position >= 5)
      .sort((a, b) => (b.progress.updatedAt || 0) - (a.progress.updatedAt || 0))
      .slice(0, 20);
  }

  const bySeries = new Map();
  for (const episode of allEpisodes()) {
    const progress = progressFor(episode.id);
    if (!progress || progress.position < 5) continue;
    const current = bySeries.get(episode.seriesId);
    if (!current || (progress.updatedAt || 0) > (current.progress.updatedAt || 0)) {
      bySeries.set(episode.seriesId, { item: episode, progress });
    }
  }

  return [...bySeries.values()]
    .sort((a, b) => (b.progress.updatedAt || 0) - (a.progress.updatedAt || 0))
    .slice(0, 20);
}

function renderLibrary() {
  if (!appState.initialized) return;

  resetObservers();
  resetMediaQueues();
  els.seriesDetailView.hidden = true;

  const isSeriesView = appState.view === 'series';
  const library = appState.library;
  const configured = Boolean(appState.config.videoRoot);
  const query = appState.query.trim();

  els.rows.textContent = '';
  els.rows.hidden = false;
  els.emptyState.hidden = true;
  updateStructureNotice();

  els.libraryEyebrow.textContent = isSeriesView ? 'Series' : 'Películas';
  els.libraryTitle.innerHTML = isSeriesView
    ? 'Tus series, <span>en casa</span>'
    : 'Tu cine, <span>en casa</span>';
  updateSearchPlaceholder();

  if (!configured) {
    els.librarySummary.textContent =
      'Elige una carpeta para empezar. Tus vídeos no salen de este equipo.';
    showEmptyState({
      title: 'Tu cine, a un clic',
      text: 'Elige la carpeta donde guardas tus vídeos. CasaFlix creará dentro las carpetas «Peliculas» y «Series» para organizarlo todo.',
      showRefresh: false,
      chooseLabel: 'Elegir carpeta de vídeos',
      hint:
        'Formatos admitidos: MP4, WebM y M4V. Las carátulas <code>poster.jpg</code> o <code>folder.jpg</code> son opcionales.',
    });
    updateStatus();
    return;
  }

  if (!library || library.error) {
    const message = (library && library.error) || 'No se pudo leer la carpeta de vídeos.';
    els.librarySummary.textContent = message;
    showEmptyState({
      title: 'La carpeta no está disponible',
      text: `${message} Puedes volver a intentarlo o elegir otra carpeta.`,
      showRefresh: true,
      chooseLabel: 'Elegir otra carpeta',
      hint:
        'Comprueba que la carpeta sigue existiendo y que CasaFlix tiene permiso para leerla.',
    });
    updateStatus();
    return;
  }

  const movies = allMovies();
  const series = allSeries();
  const episodes = allEpisodes(series);
  const warnings = library.warnings
    ? ` · ${countLabel(library.warnings, 'aviso', 'avisos')} de lectura`
    : '';

  if (query) {
    const normalizedQuery = normalizeText(query);
    if (isSeriesView) {
      const matches = series.filter(
        (entry) =>
          normalizeText(entry.title).includes(normalizedQuery) ||
          allEpisodes([entry]).some((episode) =>
            normalizeText(episode.title).includes(normalizedQuery),
          ),
      );
      els.librarySummary.textContent = `${countLabel(
        matches.length,
        'resultado',
        'resultados',
      )} para «${query}» · ${library.folderName || ''}`;

      if (matches.length === 0) {
        appendSearchEmpty(query);
      } else {
        els.rows.append(
          buildCollection(
            'Resultados',
            matches.length,
            buildSeriesGrid(matches),
          ),
        );
      }
    } else {
      const matches = movies.filter((movie) =>
        normalizeText(movie.title).includes(normalizedQuery),
      );
      els.librarySummary.textContent = `${countLabel(
        matches.length,
        'resultado',
        'resultados',
      )} para «${query}» · ${library.folderName || ''}`;

      if (matches.length === 0) {
        appendSearchEmpty(query);
      } else {
        els.rows.append(
          buildCollection('Resultados', matches.length, buildMovieGrid(matches)),
        );
      }
    }
    updateStatus();
    return;
  }

  if (isSeriesView) {
    els.librarySummary.textContent = `${countLabel(
      series.length,
      'serie',
      'series',
    )} · ${countLabel(episodes.length, 'episodio', 'episodios')}${warnings} · ${
      library.folderName || ''
    }`;

    if (series.length === 0) {
      showEmptyState({
        title: 'Aún no hay series',
        text: 'Crea una carpeta por serie dentro de «Series». Dentro puedes añadir subcarpetas por temporada o dejar los episodios directamente.',
        showRefresh: true,
        chooseLabel: 'Cambiar de carpeta',
        hint:
          'Ejemplo: <code>Series/Mi serie/Temporada 1/Episodio 1.mp4</code>. También se acepta <code>Películas</code> con tilde.',
      });
      updateStatus();
      return;
    }
  } else {
    els.librarySummary.textContent = `${countLabel(
      movies.length,
      'película',
      'películas',
    )}${warnings} · ${library.folderName || ''}`;

    if (movies.length === 0) {
      showEmptyState({
        title: 'Aún no hay películas',
        text: 'Guarda tus películas dentro de la carpeta «Peliculas». Cada vídeo compatible aparecerá aquí con su carátula y duración.',
        showRefresh: true,
        chooseLabel: 'Cambiar de carpeta',
        hint:
          'Formatos admitidos: MP4, WebM y M4V. También se acepta <code>Películas</code> con tilde.',
      });
      updateStatus();
      return;
    }
  }

  els.emptyState.hidden = true;

  const continueItems = continueEntries(isSeriesView ? 'series' : 'movies');
  if (continueItems.length > 0) {
    els.rows.append(
      buildRow(
        'Continuar viendo',
        continueItems.map((entry) => entry.item),
        {
          progressById: new Map(
            continueItems.map((entry) => [entry.item.id, entry.progress]),
          ),
          kind: isSeriesView ? 'episode' : 'movie',
        },
      ),
    );
  }

  if (isSeriesView) {
    els.rows.append(
      buildCollection('Todas tus series', series.length, buildSeriesGrid(series)),
    );
  } else {
    els.rows.append(
      buildCollection(
        'Todas tus películas',
        movies.length,
        buildMovieGrid(movies),
      ),
    );
  }

  updateStatus();
}

function backToSeries() {
  appState.detailSeriesId = null;
  appState.view = 'series';
  els.seriesDetailView.hidden = true;
  els.libraryView.hidden = false;
  els.discoverView.hidden = true;
  for (const tab of els.tabs) {
    const isActive = tab.dataset.view === 'series';
    tab.classList.toggle('is-active', isActive);
    if (isActive) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  updateSearchPlaceholder();
  renderLibrary();
  const main = document.getElementById('main');
  if (main) main.scrollTop = 0;
}

function openSeriesDetail(seriesId) {
  const series = findSeries(seriesId);
  if (!series) return;

  appState.detailSeriesId = seriesId;
  appState.view = 'series';
  for (const tab of els.tabs) {
    const isActive = tab.dataset.view === 'series';
    tab.classList.toggle('is-active', isActive);
    if (isActive) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  renderSeriesDetail();
  const main = document.getElementById('main');
  if (main) main.scrollTop = 0;
}

function renderSeriesDetail() {
  const series = findSeries(appState.detailSeriesId);
  if (!series) {
    appState.detailSeriesId = null;
    setView('series');
    return;
  }

  resetObservers();
  resetMediaQueues();
  els.libraryView.hidden = true;
  els.discoverView.hidden = true;
  els.seriesDetailView.hidden = false;

  els.seriesDetailTitle.textContent = series.title;
  els.seriesDetailMeta.textContent = `${countLabel(
    series.seasonCount,
    'temporada',
    'temporadas',
  )} · ${countLabel(series.episodeCount, 'episodio', 'episodios')}`;

  els.seriesDetailPoster.textContent = '';
  const posterImg = document.createElement('img');
  posterImg.alt = '';
  posterImg.decoding = 'async';
  posterImg.dataset.itemId = series.firstEpisodeId;
  const posterPlaceholder = document.createElement('div');
  posterPlaceholder.className = `card-placeholder tone-${toneFor(series.id)}`;
  const posterInitials = document.createElement('span');
  posterInitials.className = 'card-initials';
  posterInitials.textContent = titleInitials(series.title);
  posterPlaceholder.append(posterInitials);
  els.seriesDetailPoster.append(posterPlaceholder, posterImg);

  attachImage({
    element: els.seriesDetailPoster,
    img: posterImg,
    placeholder: posterPlaceholder,
    posterUrl: series.posterUrl,
    thumbUrl: series.thumbUrl,
    thumbItem: {
      id: series.firstEpisodeId,
      mediaUrl: series.firstEpisodeMediaUrl,
      thumbUrl: series.thumbUrl,
    },
    immediate: true,
  });

  els.detailSeasons.textContent = '';
  for (const season of series.seasons) {
    const section = document.createElement('section');
    section.className = 'season';

    const head = document.createElement('div');
    head.className = 'season-head';
    const title = document.createElement('h2');
    title.className = 'season-title';
    title.textContent = season.label;
    const count = document.createElement('span');
    count.className = 'season-count';
    count.textContent = countLabel(season.episodes.length, 'episodio', 'episodios');
    head.append(title, count);

    const list = document.createElement('div');
    list.className = 'episode-list';
    for (const episode of season.episodes) {
      list.append(createEpisodeRow(episode, season, series));
    }

    section.append(head, list);
    els.detailSeasons.append(section);
  }

  updateStatus();
}

function createEpisodeRow(episode, season, series) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'episode-row';
  row.dataset.id = episode.id;
  row.setAttribute(
    'aria-label',
    `Reproducir ${series.title}, ${season.label}, ${episode.episodeLabel}: ${episode.title}`,
  );

  const thumb = document.createElement('div');
  thumb.className = 'episode-thumb';

  const placeholder = document.createElement('div');
  placeholder.className = `card-placeholder tone-${toneFor(episode.id)}`;
  const initials = document.createElement('span');
  initials.className = 'card-initials';
  initials.textContent = String(episode.episodeNumber || '').padStart(2, '0');
  placeholder.append(initials);

  const img = document.createElement('img');
  img.className = 'card-img';
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';
  img.dataset.itemId = episode.id;
  img.hidden = true;

  thumb.append(placeholder, img);
  attachImage({
    element: row,
    img,
    placeholder,
    posterUrl: null,
    thumbUrl: episode.thumbUrl,
    thumbItem: episode,
  });

  const progress = progressFor(episode.id);
  if (progress && progress.duration > 0) {
    const percent = Math.max(
      1,
      Math.min(100, Math.round((progress.position / progress.duration) * 100)),
    );
    const tag = document.createElement('span');
    tag.className = 'card-tag';
    tag.textContent = `Continuar · ${percent} %`;
    thumb.append(tag);

    const bar = document.createElement('span');
    bar.className = 'card-progress';
    const fill = document.createElement('span');
    fill.style.width = `${percent}%`;
    bar.append(fill);
    thumb.append(bar);
  }

  const info = document.createElement('div');
  info.className = 'episode-info';

  const label = document.createElement('p');
  label.className = 'episode-label';
  label.textContent = episode.episodeLabel;
  const duration = document.createElement('span');
  duration.dataset.durationFor = episode.id;
  duration.textContent = durationLabel(episode.id);
  label.append(document.createTextNode(' · '), duration);

  const title = document.createElement('h3');
  title.className = 'episode-title';
  title.textContent = episode.title;

  const meta = document.createElement('p');
  meta.className = 'episode-meta';
  if (progress) {
    meta.textContent = `Continuar · ${formatTime(progress.position)}`;
  } else {
    meta.textContent = season.label;
  }

  info.append(label, title, meta);

  const play = document.createElement('span');
  play.className = 'episode-play';
  play.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.2v13.6L19 12z" fill="currentColor"/></svg>';

  row.append(thumb, info, play);
  row.addEventListener('click', () => openPlayer(episode));
  observeDuration(row, episode);

  return row;
}

function appendSearchEmpty(query) {
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
}

function clearSearch() {
  els.searchInput.value = '';
  appState.query = '';
  renderCurrentView();
  els.searchInput.focus();
}

function buildCollection(title, count, content) {
  const section = document.createElement('section');
  section.className = 'row';
  section.setAttribute('aria-label', title);

  const head = document.createElement('div');
  head.className = 'row-head';
  const heading = document.createElement('h2');
  heading.className = 'row-title';
  heading.textContent = title;
  const label = document.createElement('span');
  label.className = 'row-count';
  label.textContent = String(count);
  head.append(heading, label);

  section.append(head, content);
  return section;
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
        kind: options.kind || item.kind,
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

function buildMovieGrid(movies) {
  const grid = document.createElement('div');
  grid.className = 'media-grid';
  for (const movie of movies) {
    grid.append(createCard(movie, { kind: 'movie' }));
  }
  return grid;
}

function buildSeriesGrid(seriesList) {
  const grid = document.createElement('div');
  grid.className = 'media-grid';
  for (const series of seriesList) {
    grid.append(createSeriesCard(series));
  }
  return grid;
}

function createCard(item, options = {}) {
  const isEpisode = options.kind === 'episode' || Boolean(item.seriesId);
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'card';
  card.dataset.id = item.id;
  card.dataset.kind = isEpisode ? 'episode' : 'movie';
  card.setAttribute(
    'aria-label',
    isEpisode
      ? `Reproducir ${item.seriesTitle || ''}, ${item.episodeLabel || ''}: ${item.title}`
      : `Reproducir ${item.title}`,
  );

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
  img.hidden = true;

  media.append(placeholder, img);
  attachImage({
    element: card,
    img,
    placeholder,
    posterUrl: isEpisode ? null : item.posterUrl,
    thumbUrl: item.thumbUrl,
    thumbItem: item,
  });

  const play = document.createElement('span');
  play.className = 'card-play';
  play.innerHTML =
    '<span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.2v13.6L19 12z" fill="currentColor"/></svg></span>';
  media.append(play);

  const progress = options.progress || null;
  if (progress) {
    const percent =
      progress.duration > 0
        ? Math.max(
            1,
            Math.min(
              100,
              Math.round((progress.position / progress.duration) * 100),
            ),
          )
        : 0;

    const tag = document.createElement('span');
    tag.className = 'card-tag';
    tag.textContent = percent > 0 ? `Continuar · ${percent} %` : 'Continuar';
    media.append(tag);

    if (percent > 0) {
      const bar = document.createElement('span');
      bar.className = 'card-progress';
      const fill = document.createElement('span');
      fill.style.width = `${percent}%`;
      bar.append(fill);
      media.append(bar);
    }
  }

  const body = document.createElement('div');
  body.className = 'card-body';

  const title = document.createElement('p');
  title.className = 'card-title';
  title.textContent = item.title;

  const meta = document.createElement('p');
  meta.className = 'card-meta';
  if (isEpisode) {
    meta.textContent = [item.seriesTitle, item.episodeLabel]
      .filter(Boolean)
      .join(' · ');
  } else if (progress) {
    if (progress.duration > 0) {
      meta.textContent = `${formatTime(progress.position)} de ${formatTime(
        progress.duration,
      )}`;
    } else {
      meta.textContent = `Visto hasta ${formatTime(progress.position)}`;
    }
  } else {
    const duration = document.createElement('span');
    duration.dataset.durationFor = item.id;
    duration.textContent = durationLabel(item.id);
    meta.append(duration);
  }

  body.append(title, meta);
  card.append(media, body);

  card.addEventListener('click', () => openPlayer(item));
  observeDuration(card, item);

  return card;
}

function createSeriesCard(series) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'card series-card';
  card.dataset.seriesId = series.id;
  card.setAttribute('aria-label', `Abrir serie ${series.title}`);

  const media = document.createElement('div');
  media.className = 'card-media';

  const placeholder = document.createElement('div');
  placeholder.className = `card-placeholder tone-${toneFor(series.id)}`;
  const initials = document.createElement('span');
  initials.className = 'card-initials';
  initials.textContent = titleInitials(series.title);
  placeholder.append(initials);

  const img = document.createElement('img');
  img.className = 'card-img';
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';
  img.dataset.itemId = series.firstEpisodeId;
  img.hidden = true;

  media.append(placeholder, img);
  attachImage({
    element: card,
    img,
    placeholder,
    posterUrl: series.posterUrl,
    thumbUrl: series.thumbUrl,
    thumbItem: {
      id: series.firstEpisodeId,
      mediaUrl: series.firstEpisodeMediaUrl,
      thumbUrl: series.thumbUrl,
    },
  });

  const play = document.createElement('span');
  play.className = 'card-play';
  play.innerHTML =
    '<span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6.5v11L17 12z" fill="currentColor"/></svg></span>';
  media.append(play);

  const body = document.createElement('div');
  body.className = 'card-body';

  const title = document.createElement('p');
  title.className = 'card-title';
  title.textContent = series.title;

  const meta = document.createElement('p');
  meta.className = 'card-meta';
  meta.textContent = `${countLabel(
    series.seasonCount,
    'temporada',
    'temporadas',
  )} · ${countLabel(series.episodeCount, 'episodio', 'episodios')}`;

  body.append(title, meta);
  card.append(media, body);
  card.addEventListener('click', () => openSeriesDetail(series.id));

  return card;
}

function attachImage({
  element,
  img,
  placeholder,
  posterUrl,
  thumbUrl,
  thumbItem,
  immediate = false,
}) {
  const showThumb = (url) => {
    if (!url || !img.isConnected) return;
    img.dataset.source = 'thumb';
    img.hidden = false;
    img.src = url;
    img.addEventListener(
      'load',
      () => {
        placeholder.hidden = true;
      },
      { once: true },
    );
    img.addEventListener(
      'error',
      () => {
        img.hidden = true;
        placeholder.hidden = false;
      },
      { once: true },
    );
  };

  const requestFallback = () => {
    if (!thumbItem || !thumbItem.id) return;
    if (thumbItem.thumbUrl) {
      showThumb(thumbItem.thumbUrl);
      return;
    }
    if (immediate) {
      requestThumb(thumbItem, showThumb);
      return;
    }
    observeThumb(element, {
      img,
      placeholder,
      start: () => requestThumb(thumbItem, showThumb),
    });
  };

  if (posterUrl) {
    img.dataset.source = 'poster';
    img.hidden = false;
    img.src = posterUrl;
    img.addEventListener(
      'load',
      () => {
        placeholder.hidden = true;
      },
      { once: true },
    );
    img.addEventListener(
      'error',
      () => {
        img.hidden = true;
        img.removeAttribute('src');
        placeholder.hidden = false;
        requestFallback();
      },
      { once: true },
    );
    return;
  }

  if (thumbUrl) {
    showThumb(thumbUrl);
    return;
  }

  requestFallback();
}

// ---------------------------------------------------------------------------
// Miniaturas: generación de fotogramas
// ---------------------------------------------------------------------------

function requestThumb(item, callback) {
  if (!item || !item.id) return;
  if (item.thumbUrl) {
    if (callback) callback(item.thumbUrl);
    return;
  }
  if (thumbQueue.failed.has(item.id)) return;

  let callbacks = thumbQueue.callbacks.get(item.id);
  if (!callbacks) {
    callbacks = new Set();
    thumbQueue.callbacks.set(item.id, callbacks);
  }
  if (callback) callbacks.add(callback);

  if (thumbQueue.inFlight.has(item.id) || thumbQueue.queuedIds.has(item.id)) {
    return;
  }

  thumbQueue.queuedIds.add(item.id);
  thumbQueue.items.push(item);
  pumpThumbQueue();
}

function pumpThumbQueue() {
  while (thumbQueue.active < MEDIA_CONCURRENCY && thumbQueue.items.length > 0) {
    const item = thumbQueue.items.shift();
    if (!item) continue;
    thumbQueue.queuedIds.delete(item.id);
    if (item.thumbUrl || thumbQueue.failed.has(item.id)) continue;

    thumbQueue.active += 1;
    const task = generateThumbnail(item)
      .then((url) => {
        if (!url) return;
        for (const episode of allEpisodes()) {
          if (episode.id === item.id) episode.thumbUrl = url;
        }
        for (const series of allSeries()) {
          if (series.firstEpisodeId === item.id) series.thumbUrl = url;
        }
        applyThumbToDom(item.id, url);
        const callbacks = thumbQueue.callbacks.get(item.id);
        if (callbacks) {
          for (const callback of callbacks) callback(url);
          thumbQueue.callbacks.delete(item.id);
        }
      })
      .catch((error) => {
        console.warn('[CasaFlix] No se pudo crear la miniatura:', error.message);
        thumbQueue.failed.add(item.id);
        thumbQueue.callbacks.delete(item.id);
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

function applyThumbToDom(itemId, url) {
  const images = document.querySelectorAll(`img[data-item-id="${itemId}"]`);
  for (const img of images) {
    if (img.dataset.source === 'poster') continue;
    img.dataset.source = 'thumb';
    img.hidden = false;
    img.src = url;

    const container = img.closest('.card-media, .episode-thumb, .series-poster');
    const placeholder = container
      ? container.querySelector('.card-placeholder')
      : null;
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
        if (placeholder) placeholder.hidden = false;
      },
      { once: true },
    );
  }
}

// ---------------------------------------------------------------------------
// Duración de los vídeos
// ---------------------------------------------------------------------------

function itemDuration(itemId) {
  const entry = appState.durations[itemId];
  return entry && Number.isFinite(entry.duration) && entry.duration > 0
    ? entry.duration
    : null;
}

function durationLabel(itemId) {
  const duration = itemDuration(itemId);
  return duration ? formatDuration(duration) : '—';
}

function requestDuration(item) {
  if (!item || !item.id || !item.mediaUrl) return;
  if (itemDuration(item.id)) {
    updateDurationDom(item.id, itemDuration(item.id));
    return;
  }
  if (durationQueue.failed.has(item.id)) return;

  if (durationQueue.inFlight.has(item.id) || durationQueue.queuedIds.has(item.id)) {
    return;
  }

  durationQueue.queuedIds.add(item.id);
  durationQueue.items.push(item);
  pumpDurationQueue();
}

function pumpDurationQueue() {
  while (durationQueue.active < MEDIA_CONCURRENCY && durationQueue.items.length > 0) {
    const item = durationQueue.items.shift();
    if (!item) continue;
    durationQueue.queuedIds.delete(item.id);
    if (itemDuration(item.id) || durationQueue.failed.has(item.id)) continue;

    durationQueue.active += 1;
    const task = probeDuration(item)
      .then((duration) => {
        if (!duration) return;
        appState.durations[item.id] = {
          duration,
          updatedAt: Date.now(),
        };
        updateDurationDom(item.id, duration);
      })
      .catch((error) => {
        durationQueue.failed.add(item.id);
        console.warn('[CasaFlix] No se pudo leer la duración:', error.message);
      })
      .finally(() => {
        durationQueue.inFlight.delete(item.id);
        durationQueue.active -= 1;
        pumpDurationQueue();
      });

    durationQueue.inFlight.set(item.id, task);
  }
}

async function probeDuration(item) {
  const video = document.createElement('video');
  video.className = 'thumb-work';
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.src = item.mediaUrl;
  document.body.append(video);

  try {
    video.load();
    if (video.readyState < 1) {
      await waitForMediaEvent(video, 'loadedmetadata', 12000);
    }

    let duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      duration = await resolveInfiniteDuration(video);
    }

    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('Duración desconocida.');
    }

    await api.saveDuration(item.id, duration).catch(() => {});
    return Math.round(duration * 100) / 100;
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
  }
}

async function resolveInfiniteDuration(video) {
  const changed = new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener('durationchange', finish);
      video.removeEventListener('seeked', finish);
      resolve();
    };
    video.addEventListener('durationchange', finish, { once: true });
    video.addEventListener('seeked', finish, { once: true });
    window.setTimeout(finish, 1800);
  });

  try {
    video.currentTime = 1e7;
  } catch {
    return null;
  }

  await changed;
  const duration = video.duration;
  try {
    video.currentTime = 0;
  } catch {
    // Sin búsqueda disponible.
  }
  return duration;
}

function updateDurationDom(itemId, duration) {
  const label = formatDuration(duration);
  const nodes = document.querySelectorAll(`[data-duration-for="${itemId}"]`);
  for (const node of nodes) node.textContent = label;
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
      const library = result.snapshot.library;
      if (library) {
        showToast(
          `Biblioteca lista: ${countLabel(
            library.movieCount || 0,
            'película',
            'películas',
          )} · ${countLabel(library.seriesCount || 0, 'serie', 'series')}.`,
        );
      }
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
      const library = snapshot.library || {};
      showToast(
        `Biblioteca actualizada: ${countLabel(
          library.movieCount || 0,
          'película',
          'películas',
        )} · ${countLabel(library.seriesCount || 0, 'serie', 'series')}.`,
      );
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
  if (!item) return;

  appState.playQueue = item.seriesId ? episodesOfSeries(item.seriesId) : [];
  appState.playIndex = appState.playQueue.findIndex((entry) => entry.id === item.id);

  if (!appState.playing) {
    appState.playing = true;
    els.playerView.hidden = false;
    document.body.classList.add('is-playing');
  }

  startPlayback(item);
}

function startPlayback(item) {
  appState.currentItem = item;
  appState.playbackEnded = false;
  appState.lastSavedAt = 0;

  const isEpisode = Boolean(item.seriesId);
  const next = nextEpisode();

  els.playerTitle.textContent = item.title;
  els.playerSubtitle.textContent = isEpisode
    ? [item.seriesTitle, item.seasonLabel, item.episodeLabel]
        .filter(Boolean)
        .join(' · ')
    : `Película · ${item.extension.replace('.', '').toUpperCase()}`;
  els.playerNotice.hidden = true;
  window.clearTimeout(playerNoticeTimer);

  els.playerNext.hidden = !next;
  els.playerNext.classList.remove('is-highlighted');
  if (next) {
    els.playerNext.title = `Siguiente: ${next.episodeLabel} · ${next.title}`;
    els.playerNext.setAttribute(
      'aria-label',
      `Reproducir siguiente episodio: ${next.episodeLabel} · ${next.title}`,
    );
  } else {
    els.playerNext.removeAttribute('title');
    els.playerNext.removeAttribute('aria-label');
  }

  const video = els.playerVideo;
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

  video.src = item.mediaUrl;
  video.load();
  video.focus();
}

function nextEpisode() {
  if (appState.playIndex < 0) return null;
  return appState.playQueue[appState.playIndex + 1] || null;
}

function playNextEpisode() {
  const next = nextEpisode();
  if (!next) return;
  if (!appState.playbackEnded) saveCurrentProgress(true);
  appState.playIndex += 1;
  startPlayback(next);
}

function handlePlaybackEnded() {
  const item = appState.currentItem;
  if (!item) return;
  appState.playbackEnded = true;
  delete appState.progress[item.id];
  if (api) api.clearProgress(item.id).catch(() => {});

  const next = nextEpisode();
  if (next) {
    showPlayerNotice(
      `Fin del episodio. Siguiente: ${next.episodeLabel} · ${next.title}.`,
      9000,
    );
    els.playerNext.classList.add('is-highlighted');
  } else if (item.seriesId) {
    showPlayerNotice('Fin de la serie. La próxima vez empezará desde el principio.', 7000);
  } else {
    showPlayerNotice('Fin de la película. La próxima vez empezará desde el principio.', 7000);
  }
}

function saveCurrentProgress(force) {
  const item = appState.currentItem;
  if (!appState.playing || !item || appState.playbackEnded) return;

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
  appState.playbackEnded = false;
  appState.currentItem = null;
  appState.playQueue = [];
  appState.playIndex = -1;

  video.onloadedmetadata = null;
  video.pause();
  video.removeAttribute('src');
  video.load();

  els.playerView.hidden = true;
  els.playerNotice.hidden = true;
  els.playerNext.hidden = true;
  window.clearTimeout(playerNoticeTimer);
  document.body.classList.remove('is-playing');

  renderCurrentView();

  if (item) {
    const selector = appState.detailSeriesId
      ? `.episode-row[data-id="${item.id}"]`
      : `.card[data-id="${item.id}"]`;
    const card = document.querySelector(selector);
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

function updateStructureNotice() {
  const library = appState.library;
  const created = library && library.structure ? library.structure.created : [];
  if (
    !created ||
    created.length === 0 ||
    appState.structureNoticeDismissed
  ) {
    els.structureNotice.hidden = true;
    return;
  }

  const names = created.map((name) => `«${name}»`).join(' y ');
  els.structureNoticeText.textContent =
    `Hemos creado ${names} dentro de tu carpeta. Guarda cada película en «Peliculas» ` +
    'y cada serie en su propia carpeta dentro de «Series». Dentro de una serie puedes ' +
    'usar subcarpetas por temporada o poner los episodios directamente.';
  els.structureNotice.hidden = false;
}

function updateStatus() {
  const library = appState.library;

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

  const movieCount = library ? library.movieCount || 0 : 0;
  const seriesCount = library ? library.seriesCount || 0 : 0;

  els.statusCount.textContent = `${countLabel(
    movieCount,
    'película',
    'películas',
  )} · ${countLabel(seriesCount, 'serie', 'series')}`;
  els.statusFolder.textContent = library && library.folderName
    ? `Carpeta: ${library.folderName}`
    : '';
  if (library && library.warnings > 0) {
    els.statusFolder.textContent += ` · ${countLabel(
      library.warnings,
      'aviso',
      'avisos',
    )} de lectura`;
  }
}

function showEmptyState({ title, text, showRefresh, chooseLabel, hint }) {
  els.emptyTitle.textContent = title;
  els.emptyText.textContent = text;
  els.emptyRefreshBtn.hidden = !showRefresh;
  if (chooseLabel) els.emptyChooseBtn.textContent = chooseLabel;
  if (hint) els.emptyHint.innerHTML = hint;
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

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total} s`;
  if (total < 3600) return `${Math.round(total / 60)} min`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
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
