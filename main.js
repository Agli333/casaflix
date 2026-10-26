'use strict';

const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  shell,
} = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

// ---------------------------------------------------------------------------
// Constantes y rutas
// ---------------------------------------------------------------------------

const APP_SCHEME = 'casaflix';
const APP_ORIGIN = `${APP_SCHEME}://app`;
const RENDERER_DIR = path.join(__dirname, 'renderer');
const LINKS_FILE = path.join(__dirname, 'links.json');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.m4v']);
const POSTER_FILES = [
  'poster.jpg',
  'poster.jpeg',
  'poster.png',
  'poster.webp',
  'folder.jpg',
  'folder.jpeg',
  'folder.png',
  'folder.webp',
];
const MOVIES_FOLDER = 'Peliculas';
const SERIES_FOLDER = 'Series';
const UNKNOWN_SEASON_LABEL = 'Sin temporada';
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '@eadir',
  '#recycle',
  '$recycle.bin',
  'system volume information',
  'lost+found',
]);

const MAX_THUMBNAIL_BYTES = 3 * 1024 * 1024;
const MAX_THUMBNAIL_DATA_URL = 8 * 1024 * 1024;
const MAX_PROGRESS_ENTRIES = 500;
const MAX_DURATION_ENTRIES = 5000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
};

const collator = new Intl.Collator('es', { sensitivity: 'base', numeric: true });

// Permite aislar los datos de la aplicación en pruebas o en un uso portable.
app.setName('CasaFlix');
if (process.env.CASAFLIX_USER_DATA) {
  const customUserData = path.resolve(process.env.CASAFLIX_USER_DATA);
  fs.mkdirSync(customUserData, { recursive: true });
  app.setPath('userData', customUserData);
}

const USER_DATA_DIR = app.getPath('userData');
const CONFIG_FILE = path.join(USER_DATA_DIR, 'config.json');
const PROGRESS_FILE = path.join(USER_DATA_DIR, 'progress.json');
const DURATIONS_FILE = path.join(USER_DATA_DIR, 'durations.json');
const THUMBS_DIR = path.join(USER_DATA_DIR, 'thumbnails');

// ---------------------------------------------------------------------------
// Estado en memoria
// ---------------------------------------------------------------------------

const state = {
  config: {
    videoRoot: null,
  },
  library: emptyLibrary(null),
  progress: {},
  durations: {},
  links: [],
  linksError: null,
};

/** @type {Map<string, {filePath: string, size: number, mtimeMs: number}>} */
let itemIndex = new Map();
/** @type {Map<string, string>} */
let posterIndex = new Map();

let mainWindow = null;
let scanPromise = null;
let progressWriteChain = Promise.resolve();
let durationWriteChain = Promise.resolve();

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function emptyLibrary(root) {
  return {
    root: root || null,
    folderName: root ? path.basename(root) : null,
    movies: [],
    series: [],
    itemCount: 0,
    movieCount: 0,
    seriesCount: 0,
    episodeCount: 0,
    structure: {
      movies: [],
      series: [],
      created: [],
    },
    scannedAt: null,
    error: null,
    warnings: 0,
  };
}

function hash(value, length = 16) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, length);
}

function normalizeForId(filePath) {
  const resolved = path.normalize(path.resolve(filePath));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function itemIdFor(filePath) {
  return hash(normalizeForId(filePath));
}

function thumbnailFileName(entry) {
  return `${itemIdFor(entry.filePath)}-${hash(`${entry.mtimeMs}:${entry.size}`, 8)}.jpg`;
}

function thumbUrlFor(fileName) {
  return `${APP_ORIGIN}/thumb/${encodeURIComponent(fileName)}`;
}

function mediaUrlFor(item, mtimeMs) {
  return `${APP_ORIGIN}/media/${item.id}?v=${Math.floor(mtimeMs)}`;
}

async function readJson(file, fallback) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`[CasaFlix] No se pudo leer ${path.basename(file)}:`, error.message);
    }
    return fallback;
  }
}

async function writeJsonAtomic(file, data) {
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(tempFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fsp.rename(tempFile, file);
}

function queueProgressWrite() {
  const payload = JSON.parse(JSON.stringify(state.progress));
  progressWriteChain = progressWriteChain
    .catch(() => {})
    .then(() => writeJsonAtomic(PROGRESS_FILE, payload))
    .catch((error) => {
      console.warn('[CasaFlix] No se pudo guardar el progreso:', error.message);
    });
  return progressWriteChain;
}

function queueDurationWrite() {
  const payload = JSON.parse(JSON.stringify(state.durations));
  durationWriteChain = durationWriteChain
    .catch(() => {})
    .then(() => writeJsonAtomic(DURATIONS_FILE, payload))
    .catch((error) => {
      console.warn('[CasaFlix] No se pudo guardar la duración:', error.message);
    });
  return durationWriteChain;
}

function sanitizeProgress(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const entries = [];
  for (const [id, value] of Object.entries(raw)) {
    if (!/^[a-f0-9]{16}$/.test(id) || !value || typeof value !== 'object') continue;
    const position = Number(value.position);
    const duration = Number(value.duration);
    const updatedAt = Number(value.updatedAt);
    if (!Number.isFinite(position) || position < 0) continue;
    entries.push([
      id,
      {
        position: Math.round(position * 100) / 100,
        duration:
          Number.isFinite(duration) && duration > 0
            ? Math.round(duration * 100) / 100
            : 0,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
      },
    ]);
  }
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  return Object.fromEntries(entries.slice(0, MAX_PROGRESS_ENTRIES));
}

function sanitizeDurations(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const entries = [];
  for (const [id, value] of Object.entries(raw)) {
    if (!/^[a-f0-9]{16}$/.test(id) || !value || typeof value !== 'object') continue;
    const duration = Number(value.duration);
    const updatedAt = Number(value.updatedAt);
    if (!Number.isFinite(duration) || duration <= 0) continue;
    entries.push([
      id,
      {
        duration: Math.round(duration * 100) / 100,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
      },
    ]);
  }
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  return Object.fromEntries(entries.slice(0, MAX_DURATION_ENTRIES));
}

function sanitizeVideoRoot(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const resolved = path.resolve(value);
  return path.isAbsolute(resolved) ? resolved : null;
}

function foldName(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function isMoviesFolder(name) {
  return foldName(name) === 'peliculas';
}

function isSeriesFolder(name) {
  return foldName(name) === 'series';
}

// ---------------------------------------------------------------------------
// Biblioteca: películas y series
// ---------------------------------------------------------------------------

async function readEntries(directory, errors) {
  try {
    return await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    errors.push(directory);
    return null;
  }
}

function sortedEntries(entries) {
  return entries
    .slice()
    .sort((a, b) => collator.compare(a.name, b.name));
}

function registerPosterFile(filePath, nextPosterIndex) {
  const token = hash(normalizeForId(filePath));
  nextPosterIndex.set(token, filePath);
  return `${APP_ORIGIN}/poster/${token}`;
}

function registerDirectoryPoster(entries, directory, nextPosterIndex) {
  const files = new Map();
  for (const entry of entries) {
    if (entry.isFile()) files.set(entry.name.toLowerCase(), entry.name);
  }

  for (const name of POSTER_FILES) {
    const match = files.get(name);
    if (match) {
      return registerPosterFile(path.join(directory, match), nextPosterIndex);
    }
  }
  return null;
}

function registerNamedPoster(entries, directory, baseName, nextPosterIndex) {
  const files = new Set();
  for (const entry of entries) {
    if (entry.isFile()) files.add(entry.name.toLowerCase());
  }

  for (const extension of ['.jpg', '.jpeg', '.png', '.webp']) {
    const candidate = `${baseName}${extension}`.toLowerCase();
    if (files.has(candidate)) {
      return registerPosterFile(path.join(directory, `${baseName}${extension}`), nextPosterIndex);
    }
  }
  return null;
}

function buildVideoItem(entry, stats, extension, posterUrl, context) {
  const fullPath = context.fullPath;
  const id = itemIdFor(fullPath);
  const title = path.basename(entry.name, path.extname(entry.name)).trim() || entry.name;
  const entryInfo = { filePath: fullPath, size: stats.size, mtimeMs: stats.mtimeMs };
  context.nextVideoIndex.set(id, entryInfo);

  const thumbName = thumbnailFileName(entryInfo);
  const item = {
    id,
    title,
    fileName: entry.name,
    kind: context.kind,
    extension,
    size: stats.size,
    mediaUrl: mediaUrlFor({ id }, stats.mtimeMs),
    posterUrl,
    thumbUrl: fs.existsSync(path.join(THUMBS_DIR, thumbName))
      ? thumbUrlFor(thumbName)
      : null,
  };

  if (context.seriesMeta) {
    Object.assign(item, context.seriesMeta);
  }

  return item;
}

async function collectVideos(directory, context, inheritedPoster = null, options = {}) {
  const entries = await readEntries(directory, context.errors);
  if (!entries) return [];

  const ordered = sortedEntries(entries);
  const ownPoster = registerDirectoryPoster(
    ordered,
    directory,
    context.nextPosterIndex,
  );
  const posterFallback = ownPoster || inheritedPoster || null;
  const videos = [];

  for (const entry of ordered) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;

    if (entry.isDirectory()) {
      if (options.recurse === false) continue;
      if (SKIP_DIRECTORIES.has(entry.name.toLowerCase())) continue;
      videos.push(
        ...(await collectVideos(fullPath, context, posterFallback, options)),
      );
      continue;
    }

    if (!entry.isFile()) continue;
    if (entry.name.startsWith('._')) continue;

    const extension = path.extname(entry.name).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(extension)) continue;

    let stats;
    try {
      stats = await fsp.stat(fullPath);
    } catch {
      context.errors.push(fullPath);
      continue;
    }
    if (!stats.isFile()) continue;

    const baseName = path.basename(entry.name, path.extname(entry.name));
    const namedPoster = registerNamedPoster(
      ordered,
      directory,
      baseName,
      context.nextPosterIndex,
    );

    videos.push(
      buildVideoItem(
        entry,
        stats,
        extension,
        namedPoster || posterFallback,
        { ...context, fullPath },
      ),
    );
  }

  return videos;
}

function parseSeasonNumber(label) {
  const match =
    /(?:temporada|season|temp\.?|t)\s*0*(\d{1,3})/i.exec(label) ||
    /^0*(\d{1,3})(?=[\s._-]|$)/.exec(label);
  return match ? Number(match[1]) : null;
}

const EPISODE_PATTERNS = [
  /(?:^|[\s._-])s\d{1,2}[\s._-]*e(?:p)?[\s._-]*(\d{1,3})(?=[\s._-]|$)/i,
  /(?:^|[\s._-])\d{1,2}x(\d{1,3})(?=[\s._-]|$)/i,
  /(?:^|[\s._-])(?:episodio|episode|cap[ií]tulo|cap\.?|ep\.?)[\s._-]*0*(\d{1,3})(?=[\s._-]|$)/i,
  /^0*(\d{1,3})(?=[\s._-]|$)/,
];

function parseEpisodeName(title) {
  const value = String(title).trim();
  for (const pattern of EPISODE_PATTERNS) {
    const match = pattern.exec(value);
    if (!match) continue;
    const number = Number(match[1]);
    if (!Number.isFinite(number)) continue;
    const cleaned = value
      .replace(match[0], ' ')
      .replace(/^[\s._-]+|[\s._-]+$/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return { number, title: cleaned || value };
  }
  return { number: null, title: value };
}

function finalizeEpisodes(rawEpisodes) {
  const prepared = rawEpisodes.map((item) => ({
    item,
    parsed: parseEpisodeName(item.title),
  }));

  prepared.sort((a, b) => {
    const aNumber = a.parsed.number ?? Number.MAX_SAFE_INTEGER;
    const bNumber = b.parsed.number ?? Number.MAX_SAFE_INTEGER;
    if (aNumber !== bNumber) return aNumber - bNumber;
    return collator.compare(a.item.fileName, b.item.fileName);
  });

  return prepared.map(({ item, parsed }, index) => {
    const number = parsed.number ?? index + 1;
    return {
      ...item,
      title: parsed.title || item.title,
      episodeNumber: number,
      episodeLabel: `Episodio ${number}`,
    };
  });
}

function buildSeries({ seriesPath, title, posterUrl, rawSeasons }) {
  const seasons = rawSeasons
    .map((season) => ({
      ...season,
      episodes: finalizeEpisodes(season.episodes),
    }))
    .filter((season) => season.episodes.length > 0)
    .sort((a, b) => {
      const aNumber = Number.isFinite(a.number) ? a.number : Number.MAX_SAFE_INTEGER;
      const bNumber = Number.isFinite(b.number) ? b.number : Number.MAX_SAFE_INTEGER;
      if (aNumber !== bNumber) return aNumber - bNumber;
      return collator.compare(a.label, b.label);
    })
    .map((season, index) => ({
      id: hash(`${normalizeForId(seriesPath)}::season::${index}`),
      label: season.label,
      number: Number.isFinite(season.number) ? season.number : index + 1,
      episodes: season.episodes,
    }));

  if (seasons.length === 0) return null;

  const firstEpisode = seasons[0].episodes[0];
  const episodeCount = seasons.reduce(
    (total, season) => total + season.episodes.length,
    0,
  );

  return {
    id: hash(normalizeForId(seriesPath)),
    title,
    posterUrl,
    thumbUrl: firstEpisode.thumbUrl,
    firstEpisodeId: firstEpisode.id,
    firstEpisodeMediaUrl: firstEpisode.mediaUrl,
    firstEpisodeTitle: firstEpisode.title,
    seasons,
    seasonCount: seasons.length,
    episodeCount,
  };
}

async function collectSeriesFromContainer(container, context) {
  const entries = await readEntries(container, context.errors);
  if (!entries) return [];

  const seriesEntries = sortedEntries(entries).filter(
    (entry) =>
      entry.isDirectory() &&
      !entry.isSymbolicLink() &&
      !SKIP_DIRECTORIES.has(entry.name.toLowerCase()),
  );

  const seriesList = [];

  for (const seriesEntry of seriesEntries) {
    const seriesPath = path.join(container, seriesEntry.name);
    const seriesFiles = await readEntries(seriesPath, context.errors);
    if (!seriesFiles) continue;

    const orderedFiles = sortedEntries(seriesFiles);
    const posterUrl = registerDirectoryPoster(
      orderedFiles,
      seriesPath,
      context.nextPosterIndex,
    );
    const seriesId = hash(normalizeForId(seriesPath));
    const seriesMeta = {
      seriesId,
      seriesTitle: seriesEntry.name,
    };

    const seasonDirs = orderedFiles.filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        !SKIP_DIRECTORIES.has(entry.name.toLowerCase()),
    );

    const rawSeasons = [];

    if (seasonDirs.length === 0) {
      const episodes = await collectVideos(
        seriesPath,
        {
          ...context,
          kind: 'episode',
          seriesMeta: {
            ...seriesMeta,
            seasonLabel: 'Temporada 1',
            seasonNumber: 1,
          },
        },
        posterUrl,
      );
      if (episodes.length > 0) {
        rawSeasons.push({
          label: 'Temporada 1',
          number: 1,
          episodes,
        });
      }
    } else {
      for (const seasonEntry of seasonDirs) {
        const seasonPath = path.join(seriesPath, seasonEntry.name);
        const seasonNumber = parseSeasonNumber(seasonEntry.name);
        const episodes = await collectVideos(
          seasonPath,
          {
            ...context,
            kind: 'episode',
            seriesMeta: {
              ...seriesMeta,
              seasonLabel: seasonEntry.name,
              seasonNumber,
            },
          },
          posterUrl,
        );
        if (episodes.length > 0) {
          rawSeasons.push({
            label: seasonEntry.name,
            number: seasonNumber,
            episodes,
          });
        }
      }

      const looseEpisodes = await collectVideos(
        seriesPath,
        {
          ...context,
          kind: 'episode',
          seriesMeta: {
            ...seriesMeta,
            seasonLabel: UNKNOWN_SEASON_LABEL,
            seasonNumber: null,
          },
        },
        posterUrl,
        { recurse: false },
      );
      if (looseEpisodes.length > 0) {
        rawSeasons.push({
          label: UNKNOWN_SEASON_LABEL,
          number: null,
          episodes: looseEpisodes,
        });
      }
    }

    const series = buildSeries({
      seriesPath,
      title: seriesEntry.name,
      posterUrl,
      rawSeasons,
    });
    if (series) seriesList.push(series);
  }

  return seriesList;
}

async function scanLibrary(root) {
  if (!root) return emptyLibrary(null);

  let rootStat;
  try {
    rootStat = await fsp.stat(root);
  } catch {
    return {
      ...emptyLibrary(root),
      error: 'La carpeta seleccionada ya no está disponible.',
    };
  }

  if (!rootStat.isDirectory()) {
    return {
      ...emptyLibrary(root),
      error: 'La ruta seleccionada no es una carpeta.',
    };
  }

  const errors = [];
  const nextVideoIndex = new Map();
  const nextPosterIndex = new Map();
  const created = [];

  const rootEntries = (await readEntries(root, errors)) || [];
  const orderedRoot = sortedEntries(rootEntries);

  let movieContainers = orderedRoot
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        isMoviesFolder(entry.name),
    )
    .map((entry) => path.join(root, entry.name));

  let seriesContainers = orderedRoot
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        isSeriesFolder(entry.name),
    )
    .map((entry) => path.join(root, entry.name));

  if (movieContainers.length === 0) {
    const target = path.join(root, MOVIES_FOLDER);
    try {
      await fsp.mkdir(target, { recursive: true });
      movieContainers = [target];
      created.push(MOVIES_FOLDER);
    } catch (error) {
      errors.push(target);
      console.warn('[CasaFlix] No se pudo crear la carpeta de películas:', error.message);
    }
  }

  if (seriesContainers.length === 0) {
    const target = path.join(root, SERIES_FOLDER);
    try {
      await fsp.mkdir(target, { recursive: true });
      seriesContainers = [target];
      created.push(SERIES_FOLDER);
    } catch (error) {
      errors.push(target);
      console.warn('[CasaFlix] No se pudo crear la carpeta de series:', error.message);
    }
  }

  const context = {
    errors,
    nextVideoIndex,
    nextPosterIndex,
    kind: 'movie',
    seriesMeta: null,
  };

  const movies = [];
  for (const container of movieContainers) {
    movies.push(...(await collectVideos(container, context, null)));
  }
  movies.sort(
    (a, b) =>
      collator.compare(a.title, b.title) ||
      collator.compare(a.fileName, b.fileName),
  );

  const series = [];
  for (const container of seriesContainers) {
    series.push(...(await collectSeriesFromContainer(container, context)));
  }
  series.sort((a, b) => collator.compare(a.title, b.title));

  const episodeCount = series.reduce(
    (total, entry) => total + entry.episodeCount,
    0,
  );

  itemIndex = nextVideoIndex;
  posterIndex = nextPosterIndex;

  // Los datos de duración de archivos que ya no están en la biblioteca se
  // descartan; el progreso guardado se conserva intacto.
  const liveIds = new Set(itemIndex.keys());
  const prunedDurations = Object.fromEntries(
    Object.entries(state.durations).filter(([id]) => liveIds.has(id)),
  );
  if (Object.keys(prunedDurations).length !== Object.keys(state.durations).length) {
    state.durations = prunedDurations;
    queueDurationWrite();
  }

  // Elimina miniaturas que ya no pertenecen a la biblioteca actual.
  const keep = new Set();
  for (const entry of itemIndex.values()) keep.add(thumbnailFileName(entry));
  void cleanThumbnails(keep);

  return {
    root,
    folderName: path.basename(root),
    movies,
    series,
    itemCount: movies.length + episodeCount,
    movieCount: movies.length,
    seriesCount: series.length,
    episodeCount,
    structure: {
      movies: movieContainers.map((container) => path.basename(container)),
      series: seriesContainers.map((container) => path.basename(container)),
      created,
    },
    scannedAt: new Date().toISOString(),
    error: null,
    warnings: errors.length,
  };
}

async function cleanThumbnails(keep) {
  try {
    const files = await fsp.readdir(THUMBS_DIR);
    await Promise.all(
      files
        .filter((file) => file.endsWith('.jpg') && !keep.has(file))
        .map((file) =>
          fsp.unlink(path.join(THUMBS_DIR, file)).catch(() => {}),
        ),
    );
  } catch {
    // La carpeta puede no existir todavía.
  }
}

async function refreshLibrary() {
  if (scanPromise) return scanPromise;
  scanPromise = (async () => {
    try {
      state.library = await scanLibrary(state.config.videoRoot);
    } catch (error) {
      console.error('[CasaFlix] Error al escanear la biblioteca:', error);
      state.library = {
        ...emptyLibrary(state.config.videoRoot),
        error: 'No se pudo leer la carpeta de vídeos.',
      };
    }
    return state.library;
  })().finally(() => {
    scanPromise = null;
  });
  return scanPromise;
}

// ---------------------------------------------------------------------------
// Configuración, progreso y enlaces
// ---------------------------------------------------------------------------

async function loadStoredData() {
  await fsp.mkdir(USER_DATA_DIR, { recursive: true });
  await fsp.mkdir(THUMBS_DIR, { recursive: true });

  const config = await readJson(CONFIG_FILE, {});
  state.config.videoRoot = sanitizeVideoRoot(config.videoRoot);
  state.progress = sanitizeProgress(await readJson(PROGRESS_FILE, {}));
  state.durations = sanitizeDurations(await readJson(DURATIONS_FILE, {}));
}

async function saveConfig() {
  await writeJsonAtomic(CONFIG_FILE, {
    videoRoot: state.config.videoRoot,
  });
}

async function loadLinks() {
  try {
    const raw = await fsp.readFile(LINKS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const source = Array.isArray(parsed) ? parsed : parsed.links;
    if (!Array.isArray(source)) {
      throw new Error('El archivo debe contener una lista de enlaces.');
    }

    const seen = new Set();
    const links = [];
    for (const [index, value] of source.entries()) {
      if (!value || typeof value !== 'object') continue;
      const name = typeof value.name === 'string' ? value.name.trim() : '';
      const url = typeof value.url === 'string' ? value.url.trim() : '';
      if (!name || !url) continue;

      let parsedUrl;
      try {
        parsedUrl = new URL(url);
      } catch {
        continue;
      }
      if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') continue;
      if (seen.has(parsedUrl.href)) continue;
      seen.add(parsedUrl.href);

      links.push({
        id:
          typeof value.id === 'string' && /^[a-z0-9-]{1,40}$/i.test(value.id)
            ? value.id
            : `enlace-${index + 1}`,
        name,
        url: parsedUrl.href,
        description:
          typeof value.description === 'string' ? value.description.trim() : '',
      });
    }

    state.links = links;
    state.linksError =
      links.length === 0
        ? 'links.json no contiene ningún enlace válido.'
        : null;
  } catch (error) {
    state.linksError = 'No se pudo leer links.json. Revisa que sea un JSON válido.';
    console.warn('[CasaFlix] Error al cargar links.json:', error.message);
  }
  return { links: state.links, error: state.linksError };
}

function buildSnapshot() {
  return {
    config: {
      videoRoot: state.config.videoRoot,
      folderName: state.config.videoRoot
        ? path.basename(state.config.videoRoot)
        : null,
    },
    library: state.library,
    progress: state.progress,
    durations: state.durations,
    links: state.links,
    linksError: state.linksError,
    online: net.isOnline(),
  };
}

// ---------------------------------------------------------------------------
// Servidor local mediante protocolo propio (sin exponer file://)
// ---------------------------------------------------------------------------

function registerAppProtocol() {
  protocol.handle(APP_SCHEME, async (request) => {
    try {
      const requestUrl = new URL(request.url);
      if (requestUrl.host !== 'app') return notFound();

      let pathname;
      try {
        pathname = decodeURIComponent(requestUrl.pathname);
      } catch {
        return notFound();
      }

      if (pathname === '/' || pathname === '/index.html') {
        return serveFile(path.join(RENDERER_DIR, 'index.html'), request, {
          cacheControl: 'no-store',
          extraHeaders: {
            'Content-Security-Policy': "frame-ancestors 'none'",
            'X-Frame-Options': 'DENY',
          },
        });
      }

      if (pathname === '/styles.css' || pathname === '/app.js') {
        return serveFile(path.join(RENDERER_DIR, pathname.slice(1)), request, {
          cacheControl: 'no-store',
        });
      }

      if (pathname.startsWith('/media/')) {
        const id = pathname.slice('/media/'.length);
        if (!/^[a-f0-9]{16}$/.test(id)) return notFound();
        const entry = itemIndex.get(id);
        if (!entry) return notFound();
        if (!VIDEO_EXTENSIONS.has(path.extname(entry.filePath).toLowerCase())) {
          return notFound();
        }
        return serveFile(entry.filePath, request, { cacheControl: 'private, max-age=0, must-revalidate' });
      }

      if (pathname.startsWith('/poster/')) {
        const token = pathname.slice('/poster/'.length);
        const posterPath = posterIndex.get(token);
        if (!posterPath) return notFound();
        return serveFile(posterPath, request, {
          cacheControl: 'private, max-age=3600',
        });
      }

      if (pathname.startsWith('/thumb/')) {
        const fileName = pathname.slice('/thumb/'.length);
        if (!/^[a-f0-9]{16}-[a-f0-9]{8}\.jpg$/.test(fileName)) return notFound();
        return serveFile(path.join(THUMBS_DIR, fileName), request, {
          cacheControl: 'private, max-age=86400',
        });
      }

      return notFound();
    } catch (error) {
      console.error('[CasaFlix] Error sirviendo un recurso:', error);
      return new Response('Error interno', {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  });
}

function notFound() {
  return new Response('No encontrado', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

async function serveFile(
  filePath,
  request,
  { cacheControl = 'no-store', extraHeaders = {} } = {},
) {
  let stats;
  try {
    stats = await fsp.stat(filePath);
  } catch {
    return notFound();
  }
  if (!stats.isFile()) return notFound();

  const extension = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[extension] || 'application/octet-stream';
  const size = stats.size;
  const baseHeaders = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  };

  const rangeHeader = request.headers.get('range');
  const range = rangeHeader ? parseRange(rangeHeader, size) : null;

  if (range && range.invalid) {
    return new Response(null, {
      status: 416,
      headers: {
        ...baseHeaders,
        'Content-Range': `bytes */${size}`,
      },
    });
  }

  if (range) {
    const { start, end } = range;
    const headers = {
      ...baseHeaders,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
    };
    if (request.method === 'HEAD') {
      return new Response(null, { status: 206, headers });
    }
    const stream = fs.createReadStream(filePath, { start, end });
    return new Response(Readable.toWeb(stream), { status: 206, headers });
  }

  const headers = {
    ...baseHeaders,
    'Content-Length': String(size),
  };
  if (request.method === 'HEAD' || size === 0) {
    return new Response(null, { status: 200, headers });
  }
  const stream = fs.createReadStream(filePath);
  return new Response(Readable.toWeb(stream), { status: 200, headers });
}

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return null;
  if (size === 0) return { invalid: true };

  const hasStart = match[1] !== '';
  const hasEnd = match[2] !== '';
  if (!hasStart && !hasEnd) return null;

  let start;
  let end;
  if (!hasStart) {
    const suffixLength = Number(match[2]);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { invalid: true };
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = hasEnd ? Number(match[2]) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { invalid: true };
    if (start >= size) return { invalid: true };
    if (end >= size) end = size - 1;
    if (end < start) return { invalid: true };
  }
  return { start, end };
}

// ---------------------------------------------------------------------------
// Ventana principal
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#080b11',
    title: 'CasaFlix',
    icon: path.join(__dirname, 'build', 'icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  mainWindow.loadURL(`${APP_ORIGIN}/index.html`);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  // Solo se permite pantalla completa (botón de los controles nativos del
  // vídeo). Cámara, micrófono, portapapeles, notificaciones, etc. quedan
  // denegados.
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, permission, callback) => callback(permission === 'fullscreen'),
  );
  mainWindow.webContents.session.setPermissionCheckHandler(
    (_webContents, permission) => permission === 'fullscreen',
  );

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('app:get-state', async () => {
    if (state.config.videoRoot && !state.library.scannedAt) {
      await refreshLibrary();
    }
    return buildSnapshot();
  });

  ipcMain.handle('library:choose-folder', async () => {
    if (!mainWindow) return { canceled: true };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Elegir carpeta de vídeos',
      buttonLabel: 'Usar esta carpeta',
      properties: ['openDirectory'],
    });

    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true };
    }

    // Si había un escaneo en curso, termina antes de cambiar la raíz para que
    // la biblioteca devuelta pertenezca siempre a la carpeta recién elegida.
    if (scanPromise) await scanPromise.catch(() => {});

    state.config.videoRoot = path.resolve(result.filePaths[0]);
    await saveConfig();
    await refreshLibrary();
    return { canceled: false, snapshot: buildSnapshot() };
  });

  ipcMain.handle('library:refresh', async () => {
    await refreshLibrary();
    return buildSnapshot();
  });

  ipcMain.handle('thumbs:save', async (_event, payload) => {
    const id = payload && typeof payload.id === 'string' ? payload.id : '';
    const dataUrl = payload && typeof payload.dataUrl === 'string' ? payload.dataUrl : '';
    const entry = itemIndex.get(id);
    if (!entry) return { ok: false, error: 'Vídeo no encontrado.' };
    if (
      dataUrl.length > MAX_THUMBNAIL_DATA_URL ||
      !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)
    ) {
      return { ok: false, error: 'Miniatura no válida.' };
    }

    let buffer;
    try {
      buffer = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    } catch {
      return { ok: false, error: 'Miniatura no válida.' };
    }
    if (!buffer.length || buffer.length > MAX_THUMBNAIL_BYTES || !looksLikeImage(buffer)) {
      return { ok: false, error: 'Miniatura no válida.' };
    }

    const fileName = thumbnailFileName(entry);
    const finalPath = path.join(THUMBS_DIR, fileName);
    const tempPath = `${finalPath}.${process.pid}.tmp`;
    try {
      await fsp.mkdir(THUMBS_DIR, { recursive: true });
      await fsp.writeFile(tempPath, buffer);
      await fsp.rename(tempPath, finalPath);
      return { ok: true, url: thumbUrlFor(fileName) };
    } catch (error) {
      await fsp.unlink(tempPath).catch(() => {});
      console.warn('[CasaFlix] No se pudo guardar la miniatura:', error.message);
      return { ok: false, error: 'No se pudo guardar la miniatura.' };
    }
  });

  ipcMain.handle('progress:save', async (_event, payload) => {
    const id = payload && typeof payload.id === 'string' ? payload.id : '';
    if (!itemIndex.has(id)) return { ok: false };
    const position = Number(payload.position);
    const duration = Number(payload.duration);
    if (!Number.isFinite(position) || position < 0) return { ok: false };

    const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;

    if (safeDuration > 0 && position >= safeDuration * 0.98) {
      delete state.progress[id];
      queueProgressWrite();
      return { ok: true, cleared: true };
    }

    state.progress[id] = {
      position: Math.round(position * 100) / 100,
      duration: Math.round(safeDuration * 100) / 100,
      updatedAt: Date.now(),
    };
    queueProgressWrite();
    return { ok: true };
  });

  ipcMain.handle('progress:clear', async (_event, id) => {
    if (typeof id === 'string' && state.progress[id]) {
      delete state.progress[id];
      queueProgressWrite();
    }
    return { ok: true };
  });

  ipcMain.handle('media:duration', async (_event, payload) => {
    const id = payload && typeof payload.id === 'string' ? payload.id : '';
    if (!itemIndex.has(id)) return { ok: false };
    const duration = Number(payload.duration);
    if (!Number.isFinite(duration) || duration <= 0) return { ok: false };

    state.durations[id] = {
      duration: Math.round(duration * 100) / 100,
      updatedAt: Date.now(),
    };
    queueDurationWrite();
    return { ok: true };
  });

  ipcMain.handle('links:get', async () => loadLinks());

  ipcMain.handle('shell:open-external', async (_event, url) => {
    if (typeof url !== 'string') {
      return { ok: false, error: 'Enlace no válido.' };
    }
    const link = state.links.find((candidate) => candidate.url === url);
    if (!link) {
      return { ok: false, error: 'Ese enlace no está permitido.' };
    }
    try {
      await shell.openExternal(link.url);
      return { ok: true };
    } catch (error) {
      console.warn('[CasaFlix] No se pudo abrir el navegador:', error.message);
      return { ok: false, error: 'No se pudo abrir el navegador.' };
    }
  });

  ipcMain.handle('net:status', () => ({ online: net.isOnline() }));
}

function looksLikeImage(buffer) {
  if (buffer.length < 12) return false;
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng =
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47;
  const isWebp =
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP';
  return isJpeg || isPng || isWebp;
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.casaflix.app');
    await loadStoredData();
    await loadLinks();
    registerAppProtocol();
    registerIpc();

    // El escaneo inicial se lanza en segundo plano; la interfaz lo espera
    // únicamente cuando pide el estado.
    if (state.config.videoRoot) {
      void refreshLibrary();
    }

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch((error) => {
    console.error('[CasaFlix] Error al arrancar:', error);
    dialog.showErrorBox(
      'CasaFlix no pudo arrancar',
      `Se produjo un error inesperado.\n\n${error.message}`,
    );
    app.quit();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
