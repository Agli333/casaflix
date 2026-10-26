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
const UNCATEGORIZED = 'Sin categoría';
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

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function emptyLibrary(root) {
  return {
    root: root || null,
    folderName: root ? path.basename(root) : null,
    categories: [],
    itemCount: 0,
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

function sanitizeVideoRoot(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const resolved = path.resolve(value);
  return path.isAbsolute(resolved) ? resolved : null;
}

// ---------------------------------------------------------------------------
// Biblioteca: escaneo recursivo
// ---------------------------------------------------------------------------

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

  const collected = [];
  const errors = [];
  const nextVideoIndex = new Map();
  const nextPosterIndex = new Map();
  const seenCategories = new Set();

  async function walk(directory, category, depth) {
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch {
      errors.push(directory);
      return;
    }

    entries.sort((a, b) => collator.compare(a.name, b.name));

    const posterByName = new Map();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (POSTER_FILES.includes(lower) && !posterByName.has(lower)) {
        posterByName.set(lower, path.join(directory, entry.name));
      }
    }
    const posterPath =
      POSTER_FILES.map((name) => posterByName.get(name)).find(Boolean) || null;

    if (posterPath) {
      const token = hash(normalizeForId(posterPath));
      nextPosterIndex.set(token, posterPath);
    }

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);

      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name.toLowerCase())) continue;
        const nextCategory = depth === 0 ? entry.name : category;
        if (depth === 0) seenCategories.add(entry.name);
        await walk(fullPath, nextCategory, depth + 1);
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
        errors.push(fullPath);
        continue;
      }
      if (!stats.isFile()) continue;

      const id = itemIdFor(fullPath);
      const itemCategory = category || UNCATEGORIZED;
      const baseName = path.basename(entry.name, path.extname(entry.name)).trim();
      const entryInfo = { filePath: fullPath, size: stats.size, mtimeMs: stats.mtimeMs };
      nextVideoIndex.set(id, entryInfo);

      const thumbName = thumbnailFileName(entryInfo);
      const hasThumb = fs.existsSync(path.join(THUMBS_DIR, thumbName));
      const posterUrl = posterPath
        ? `${APP_ORIGIN}/poster/${hash(normalizeForId(posterPath))}`
        : null;

      collected.push({
        id,
        title: baseName || entry.name,
        fileName: entry.name,
        category: itemCategory,
        extension,
        size: stats.size,
        mediaUrl: mediaUrlFor({ id }, stats.mtimeMs),
        posterUrl,
        thumbUrl: hasThumb ? thumbUrlFor(thumbName) : null,
      });
    }
  }

  await walk(root, null, 0);

  collected.sort(
    (a, b) =>
      collator.compare(a.title, b.title) ||
      collator.compare(a.fileName, b.fileName),
  );

  const grouped = new Map();
  for (const item of collected) {
    if (!grouped.has(item.category)) grouped.set(item.category, []);
    grouped.get(item.category).push(item);
  }

  const categories = [...grouped.entries()]
    .map(([name, items]) => ({ name, count: items.length, items }))
    .sort((a, b) => {
      if (a.name === UNCATEGORIZED) return 1;
      if (b.name === UNCATEGORIZED) return -1;
      return collator.compare(a.name, b.name);
    });

  itemIndex = nextVideoIndex;
  posterIndex = nextPosterIndex;

  // Elimina miniaturas que ya no pertenecen a la biblioteca actual.
  const keep = new Set();
  for (const entry of itemIndex.values()) keep.add(thumbnailFileName(entry));
  void cleanThumbnails(keep);

  return {
    root,
    folderName: path.basename(root),
    categories,
    itemCount: collected.length,
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

async function serveFile(filePath, request, { cacheControl = 'no-store' } = {}) {
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
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);

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
