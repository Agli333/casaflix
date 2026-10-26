import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronPath = require('electron');

const ROOT = path.resolve('.');
const USER_DATA = path.join(ROOT, '.test-userdata');
const MEDIA = path.join(ROOT, '.test-media');
const FLAT = path.join(ROOT, '.test-flat');
const ARTIFACTS = path.join(ROOT, '.test-artifacts');
const THUMBS = path.join(USER_DATA, 'thumbnails');
const PORT = 9333;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
const failures = [];
const consoleErrors = [];

function check(name, condition, detail = '') {
  const pass = Boolean(condition);
  results.push({ name, pass, detail });
  if (!pass) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}

async function waitFor(label, fn, timeout = 30000, interval = 200) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      if (value) return value;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new Error(
    `Tiempo de espera agotado (${label})${lastError ? `: ${lastError.message}` : ''}`,
  );
}

async function waitForThumbFiles(minimum, timeout = 30000) {
  return waitFor(
    `miniaturas en disco (${minimum})`,
    async () => {
      try {
        const files = (await fs.readdir(THUMBS)).filter((file) => file.endsWith('.jpg'));
        return files.length >= minimum ? files : null;
      } catch {
        return null;
      }
    },
    timeout,
  );
}

async function pathExists(target) {
  try {
    const stats = await fs.stat(target);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      if (message.method) {
        for (const listener of this.listeners.get(message.method) || []) {
          listener(message.params);
        }
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('No se pudo abrir CDP.')), {
        once: true,
      });
    });
    return new Cdp(ws);
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30000);
    });
  }

  async evaluate(expression, { awaitPromise = false } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const description =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        'Error al evaluar en la página.';
      throw new Error(description);
    }
    return result.result.value;
  }

  async screenshot(name) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png' });
    const target = path.join(ARTIFACTS, name);
    await fs.writeFile(target, Buffer.from(shot.data, 'base64'));
    return target;
  }
}

function startApp() {
  const child = spawn(
    electronPath,
    [
      '.',
      `--remote-debugging-port=${PORT}`,
      '--remote-allow-origins=*',
      '--autoplay-policy=no-user-gesture-required',
    ],
    {
      cwd: ROOT,
      env: { ...process.env, CASAFLIX_USER_DATA: USER_DATA },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  const logs = [];
  child.stdout.on('data', (data) => logs.push(`stdout: ${data.toString().trim()}`));
  child.stderr.on('data', (data) => logs.push(`stderr: ${data.toString().trim()}`));
  child.on('exit', (code) => logs.push(`exit: ${code}`));
  return { child, logs };
}

async function getPageTarget() {
  return waitFor('ventana de CasaFlix', async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    if (!response.ok) return null;
    const targets = await response.json();
    return (
      targets.find(
        (target) => target.type === 'page' && target.url.startsWith('casaflix://app'),
      ) || null
    );
  });
}

let active = null;

async function launchApp() {
  const instance = startApp();
  instance.exited = false;
  instance.child.on('exit', () => {
    instance.exited = true;
  });

  const target = await getPageTarget();
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  instance.cdp = cdp;

  cdp.on('Runtime.exceptionThrown', (params) => {
    consoleErrors.push(
      params.exceptionDetails?.exception?.description ||
        params.exceptionDetails?.text ||
        'Excepción en el renderer',
    );
  });
  cdp.on('Log.entryAdded', ({ entry }) => {
    if (entry.level === 'error') {
      consoleErrors.push(`${entry.source}: ${entry.text}`);
    }
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable');
  active = instance;
  return instance;
}

async function stopApp() {
  if (!active) return;
  const instance = active;
  active = null;

  if (instance.cdp) {
    await instance.cdp
      .evaluate('window.close()', { awaitPromise: false })
      .catch(() => {});
    instance.cdp.ws.close();
  }
  await sleep(1200);
  if (!instance.exited) {
    instance.child.kill();
    await sleep(600);
  }
  if (!instance.exited) {
    spawnSync('taskkill', ['/PID', String(instance.child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  }
  return instance.logs;
}

async function writeConfig(videoRoot) {
  await fs.writeFile(
    path.join(USER_DATA, 'config.json'),
    JSON.stringify({ videoRoot }, null, 2),
    'utf8',
  );
}

async function clickTab(cdp, view) {
  await cdp.evaluate(`(() => {
    document.querySelector('.tab[data-view="${view}"]').click();
    return true;
  })()`);
}

async function reloadAndWait(cdp, waitExpression, label) {
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitFor(label, async () => {
    const ok = await cdp.evaluate(waitExpression);
    return ok ? true : null;
  }, 30000);
}

async function verifyStructureCreation(instance) {
  const { cdp } = instance;

  await waitFor('biblioteca vacía creada', async () => {
    const visible = await cdp.evaluate(
      "!document.getElementById('structureNotice').hidden",
    );
    return visible ? true : null;
  }, 30000);

  const state = await cdp.evaluate(`(() => ({
    tabs: [...document.querySelectorAll('.tab')].map((tab) => tab.textContent.trim()),
    active: document.querySelector('.tab.is-active')?.dataset.view,
    noticeText: document.getElementById('structureNoticeText').textContent.replace(/\\s+/g, ' ').trim(),
    noticeVisible: !document.getElementById('structureNotice').hidden,
    emptyTitle: document.getElementById('emptyTitle').textContent,
    emptyVisible: !document.getElementById('emptyState').hidden,
    rowsHidden: document.getElementById('rows').hidden,
    statusCount: document.getElementById('statusCount').textContent,
    summary: document.getElementById('librarySummary').textContent,
    loadingHidden: document.getElementById('loadingState').hidden,
  }))()`);

  check(
    'La navegación tiene Películas, Series y Descubrir',
    JSON.stringify(state.tabs) ===
      JSON.stringify(['Películas', 'Series', 'Descubrir']),
    JSON.stringify(state.tabs),
  );
  check('La pestaña inicial es Películas', state.active === 'movies', String(state.active));
  check(
    'Se avisa de la creación de Peliculas y Series',
    state.noticeVisible &&
      state.noticeText.includes('«Peliculas»') &&
      state.noticeText.includes('«Series»') &&
      state.noticeText.includes('Hemos creado'),
    state.noticeText,
  );
  check(
    'Las carpetas Peliculas y Series se crean en disco',
    (await pathExists(path.join(FLAT, 'Peliculas'))) &&
      (await pathExists(path.join(FLAT, 'Series'))),
  );
  check(
    'La biblioteca vacía muestra su propio estado',
    state.emptyVisible && state.emptyTitle === 'Aún no hay películas' && state.rowsHidden,
    `${state.emptyTitle} | ${state.rowsHidden}`,
  );
  check(
    'El estado indica que no hay contenido',
    state.statusCount === '0 películas · 0 series',
    state.statusCount,
  );
  check('El estado de carga desaparece', state.loadingHidden === true);

  await cdp.screenshot('01-aviso-estructura.png');

  await cdp.evaluate(`(() => {
    document.getElementById('structureNoticeClose').click();
    return true;
  })()`);
  await sleep(150);
  const noticeClosed = await cdp.evaluate(
    "document.getElementById('structureNotice').hidden",
  );
  check('El aviso de estructura se puede cerrar', noticeClosed === true);
}

async function verifyMovies(instance) {
  const { cdp } = instance;

  await waitFor('películas cargadas', async () => {
    const count = await cdp.evaluate("document.querySelectorAll('.card').length");
    return count === 3 ? count : null;
  }, 30000);

  await waitFor('duraciones de películas', async () => {
    const values = await cdp.evaluate(
      "[...document.querySelectorAll('[data-duration-for]')].map((el) => el.textContent)",
    );
    return values.length === 3 && values.every((value) => /^\d+ s$/.test(value))
      ? values
      : null;
  }, 20000);

  const state = await cdp.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.card')].map((card) => ({
      title: card.querySelector('.card-title')?.textContent || '',
      meta: card.querySelector('.card-meta')?.textContent || '',
      id: card.dataset.id,
      kind: card.dataset.kind,
    }));
    const images = [...document.querySelectorAll('.card-img')];
    return {
      cards,
      summary: document.getElementById('librarySummary').textContent,
      statusCount: document.getElementById('statusCount').textContent,
      statusFolder: document.getElementById('statusFolder').textContent,
      noticeHidden: document.getElementById('structureNotice').hidden,
      emptyHidden: document.getElementById('emptyState').hidden,
      loadingHidden: document.getElementById('loadingState').hidden,
      rows: [...document.querySelectorAll('.row-title')].map((el) => el.textContent),
      posters: images.filter((img) => img.dataset.source === 'poster').length,
      posterLoaded: images.filter(
        (img) => img.dataset.source === 'poster' && img.complete && img.naturalWidth > 0,
      ).length,
      brokenVisible: images.filter(
        (img) => !img.hidden && img.complete && img.naturalWidth === 0,
      ).length,
      bodyOverflow: getComputedStyle(document.body).overflow,
    };
  })()`);

  const titles = state.cards.map((card) => card.title);
  check(
    'La pestaña Películas lista las tres películas',
    JSON.stringify(titles) ===
      JSON.stringify(['Atardecer en la costa', 'Bosque de niebla', 'Ruta por la montaña']),
    JSON.stringify(titles),
  );
  check(
    'Las películas muestran su duración',
    state.cards.every((card) => /\d+ s/.test(card.meta)),
    JSON.stringify(state.cards.map((card) => card.meta)),
  );
  check(
    'Las películas se muestran en cuadrícula',
    (await cdp.evaluate(
      "document.querySelectorAll('.media-grid .card').length",
    )) === 3,
  );
  check(
    'Se usa la carátula con el nombre de la película',
    state.posters === 1 && state.posterLoaded === 1,
    `${state.posters}/${state.posterLoaded}`,
  );
  check('No hay imágenes rotas visibles', state.brokenVisible === 0, String(state.brokenVisible));
  check('El aviso de estructura no se repite', state.noticeHidden === true);
  check('La biblioteca ocupa la vista', state.emptyHidden === true && state.loadingHidden === true);
  check(
    'El resumen indica 3 películas',
    state.summary.includes('3 películas'),
    state.summary,
  );
  check(
    'La barra de estado resume películas y series',
    state.statusCount === '3 películas · 3 series' &&
      state.statusFolder.includes('.test-media'),
    `${state.statusCount} | ${state.statusFolder}`,
  );
  check(
    'No aparece la fila Continuar viendo sin progreso',
    !state.rows.includes('Continuar viendo'),
    JSON.stringify(state.rows),
  );

  await cdp.screenshot('02-peliculas.png');

  // Recorre las tarjetas para activar la generación perezosa de miniaturas.
  await cdp.evaluate(`(async () => {
    for (const card of document.querySelectorAll('.card')) {
      card.scrollIntoView({ block: 'center', inline: 'center' });
      await new Promise((resolve) => setTimeout(resolve, 140));
    }
    document.getElementById('main').scrollTop = 0;
    return true;
  })()`, { awaitPromise: true });

  const thumbFiles = await waitForThumbFiles(2);
  check(
    'Se generan miniaturas de las películas sin carátula',
    thumbFiles.length >= 2,
    thumbFiles.join(', '),
  );

  const thumbStats = await Promise.all(
    thumbFiles.map(async (file) => (await fs.stat(path.join(THUMBS, file))).size),
  );
  check(
    'Las miniaturas tienen contenido',
    thumbStats.every((size) => size > 1000),
    thumbStats.join(', '),
  );

  await waitFor('miniaturas de películas visibles', async () => {
    const count = await cdp.evaluate(
      "[...document.querySelectorAll('.card-img')].filter((img) => img.dataset.source === 'thumb' && img.complete && img.naturalWidth > 0).length",
    );
    return count >= 2 ? count : null;
  }, 25000);

  await cdp.screenshot('03-peliculas-miniaturas.png');
}

async function verifySeries(instance) {
  const { cdp } = instance;

  await clickTab(cdp, 'series');
  await waitFor('series cargadas', async () => {
    const count = await cdp.evaluate(
      "document.querySelectorAll('.series-card').length",
    );
    return count === 3 ? count : null;
  }, 20000);

  await waitFor('carátulas de series cargadas', async () => {
    const state = await cdp.evaluate(`(() => {
      const posters = [...document.querySelectorAll('.series-card .card-img')].filter(
        (img) => img.dataset.source === 'poster',
      );
      return {
        count: posters.length,
        loaded: posters.filter((img) => img.complete && img.naturalWidth > 0).length,
      };
    })()`);
    return state.count === 2 && state.loaded === 2 ? state : null;
  }, 10000);

  const series = await cdp.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.series-card')].map((card) => ({
      title: card.querySelector('.card-title')?.textContent || '',
      meta: card.querySelector('.card-meta')?.textContent || '',
      seriesId: card.dataset.seriesId,
    }));
    const images = [...document.querySelectorAll('.card-img')];
    return {
      cards,
      summary: document.getElementById('librarySummary').textContent,
      posters: images.filter((img) => img.dataset.source === 'poster').length,
      posterLoaded: images.filter(
        (img) => img.dataset.source === 'poster' && img.complete && img.naturalWidth > 0,
      ).length,
      rows: [...document.querySelectorAll('.row-title')].map((el) => el.textContent),
      placeholder: document.getElementById('searchInput').placeholder,
    };
  })()`);

  const titles = series.cards.map((card) => card.title);
  check(
    'La pestaña Series lista las tres series',
    JSON.stringify(titles) ===
      JSON.stringify(['Crónicas del valle', 'La casa del faro', 'Mediodía']),
    JSON.stringify(titles),
  );
  check(
    'Las series muestran temporadas y episodios',
    series.cards.find((card) => card.title === 'La casa del faro')?.meta ===
      '2 temporadas · 4 episodios' &&
      series.cards.find((card) => card.title === 'Crónicas del valle')?.meta ===
        '1 temporada · 3 episodios' &&
      series.cards.find((card) => card.title === 'Mediodía')?.meta ===
        '1 temporada · 2 episodios',
    JSON.stringify(series.cards.map((card) => card.meta)),
  );
  check(
    'Se usan poster.jpg y folder.jpg como carátulas de series',
    series.posters === 2 && series.posterLoaded === 2,
    `${series.posters}/${series.posterLoaded}`,
  );
  check(
    'El resumen indica series y episodios',
    series.summary.includes('3 series') && series.summary.includes('9 episodios'),
    series.summary,
  );
  check(
    'El buscador cambia de contexto en Series',
    series.placeholder === 'Buscar en Series…',
    series.placeholder,
  );
  check(
    'No hay Continuar viendo al empezar',
    !series.rows.includes('Continuar viendo'),
    JSON.stringify(series.rows),
  );

  await waitFor('carátula de Mediodía desde miniatura', async () => {
    const loaded = await cdp.evaluate(`(() => {
      const card = [...document.querySelectorAll('.series-card')].find(
        (candidate) => candidate.querySelector('.card-title')?.textContent === 'Mediodía',
      );
      const img = card?.querySelector('.card-img');
      return Boolean(img && !img.hidden && img.complete && img.naturalWidth > 0);
    })()`);
    return loaded ? true : null;
  }, 30000);

  await cdp.screenshot('04-series.png');

  // Detalle de una serie con dos temporadas.
  await cdp.evaluate(`(() => {
    const card = [...document.querySelectorAll('.series-card')].find(
      (candidate) => candidate.querySelector('.card-title')?.textContent === 'La casa del faro',
    );
    card.click();
    return true;
  })()`);
  await waitFor('detalle de serie', async () => {
    const visible = await cdp.evaluate(
      "!document.getElementById('seriesDetailView').hidden",
    );
    return visible ? true : null;
  }, 8000);
  await sleep(400);

  const detail = await cdp.evaluate(`(() => {
    const seasons = [...document.querySelectorAll('.season')].map((season) => ({
      title: season.querySelector('.season-title')?.textContent || '',
      count: season.querySelector('.season-count')?.textContent || '',
      episodes: [...season.querySelectorAll('.episode-row')].map((row) => ({
        title: row.querySelector('.episode-title')?.textContent || '',
        label: row.querySelector('.episode-label')?.textContent || '',
        meta: row.querySelector('.episode-meta')?.textContent || '',
        id: row.dataset.id,
      })),
    }));
    const poster = document.querySelector('#seriesDetailPoster img');
    return {
      libraryHidden: document.getElementById('libraryView').hidden,
      title: document.getElementById('seriesDetailTitle').textContent,
      meta: document.getElementById('seriesDetailMeta').textContent,
      seasons,
      posterLoaded: Boolean(poster && poster.complete && poster.naturalWidth > 0),
    };
  })()`);

  check(
    'Al pulsar una serie se abre su detalle',
    detail.libraryHidden === true && detail.title === 'La casa del faro',
    detail.title,
  );
  check(
    'El detalle muestra temporadas y episodios',
    detail.meta === '2 temporadas · 4 episodios' &&
      JSON.stringify(detail.seasons.map((season) => season.title)) ===
        JSON.stringify(['Temporada 1', 'Temporada 2']),
    `${detail.meta} | ${JSON.stringify(detail.seasons.map((season) => season.title))}`,
  );
  check(
    'Los episodios se ordenan de forma natural',
    JSON.stringify(detail.seasons[0].episodes.map((episode) => episode.label)) ===
      JSON.stringify(['Episodio 1 · 5 s', 'Episodio 2 · 5 s', 'Episodio 10 · 5 s']) &&
      JSON.stringify(detail.seasons[0].episodes.map((episode) => episode.title)) ===
        JSON.stringify(['La llegada', 'La tormenta', 'El regreso']),
    JSON.stringify(detail.seasons[0].episodes),
  );
  check(
    'El detalle usa la carátula de la serie',
    detail.posterLoaded === true,
  );

  await cdp.screenshot('05-detalle-serie.png');

  // Detalle sin carpetas de temporada.
  await cdp.evaluate(`(() => {
    document.getElementById('seriesDetailBack').click();
    return true;
  })()`);
  await waitFor('vuelta a Series', async () => {
    const visible = await cdp.evaluate("!document.getElementById('libraryView').hidden");
    return visible ? true : null;
  }, 5000);

  await cdp.evaluate(`(() => {
    const card = [...document.querySelectorAll('.series-card')].find(
      (candidate) => candidate.querySelector('.card-title')?.textContent === 'Crónicas del valle',
    );
    card.click();
    return true;
  })()`);
  await waitFor('detalle de Crónicas del valle', async () => {
    const title = await cdp.evaluate(
      "document.getElementById('seriesDetailTitle').textContent",
    );
    return title === 'Crónicas del valle' ? true : null;
  }, 8000);
  await sleep(300);

  const single = await cdp.evaluate(`(() => ({
    seasons: [...document.querySelectorAll('.season-title')].map((el) => el.textContent),
    labels: [...document.querySelectorAll('.episode-label')].map((el) => el.textContent),
    titles: [...document.querySelectorAll('.episode-title')].map((el) => el.textContent),
  }))()`);
  check(
    'Sin carpetas de temporada todo es Temporada 1',
    JSON.stringify(single.seasons) === JSON.stringify(['Temporada 1']),
    JSON.stringify(single.seasons),
  );
  check(
    'Los episodios sueltos también se ordenan de forma natural',
    JSON.stringify(single.titles) ===
      JSON.stringify(['Primer día', 'La cosecha', 'Despedida']),
    JSON.stringify(single),
  );

  // Serie de una temporada sin carátula: miniatura del primer episodio.
  await cdp.evaluate(`(() => {
    document.getElementById('seriesDetailBack').click();
    return true;
  })()`);
  await waitFor('vuelta a Series de nuevo', async () => {
    const visible = await cdp.evaluate("!document.getElementById('libraryView').hidden");
    return visible ? true : null;
  }, 5000);

  await cdp.evaluate(`(() => {
    const card = [...document.querySelectorAll('.series-card')].find(
      (candidate) => candidate.querySelector('.card-title')?.textContent === 'Mediodía',
    );
    card.click();
    return true;
  })()`);
  await waitFor('detalle de Mediodía', async () => {
    const title = await cdp.evaluate(
      "document.getElementById('seriesDetailTitle').textContent",
    );
    return title === 'Mediodía' ? true : null;
  }, 8000);

  await waitFor('póster de Mediodía desde miniatura', async () => {
    const loaded = await cdp.evaluate(`(() => {
      const img = document.querySelector('#seriesDetailPoster img');
      return Boolean(img && !img.hidden && img.complete && img.naturalWidth > 0);
    })()`);
    return loaded ? true : null;
  }, 30000);

  const mediodia = await cdp.evaluate(`(() => ({
    seasons: [...document.querySelectorAll('.season-title')].map((el) => el.textContent),
    episodes: document.querySelectorAll('.episode-row').length,
    posterVisible: !document.querySelector('#seriesDetailPoster img').hidden,
  }))()`);
  check(
    'Una serie de una temporada se muestra completa',
    JSON.stringify(mediodia.seasons) === JSON.stringify(['Temporada 1']) &&
      mediodia.episodes === 2,
    JSON.stringify(mediodia),
  );
  check(
    'Sin carátula se usa la miniatura del primer episodio',
    mediodia.posterVisible === true,
  );

  await cdp.evaluate(`(() => {
    document.getElementById('seriesDetailBack').click();
    return true;
  })()`);
  await waitFor('Series tras volver', async () => {
    const count = await cdp.evaluate(
      "document.querySelectorAll('.series-card').length",
    );
    return count === 3 ? true : null;
  }, 5000);
}

async function verifyPlayer(instance) {
  const { cdp } = instance;

  // Reproductor de un episodio con siguiente episodio disponible.
  await cdp.evaluate(`(() => {
    const card = [...document.querySelectorAll('.series-card')].find(
      (candidate) => candidate.querySelector('.card-title')?.textContent === 'La casa del faro',
    );
    card.click();
    return true;
  })()`);
  await waitFor('detalle para reproducir', async () => {
    const count = await cdp.evaluate("document.querySelectorAll('.episode-row').length");
    return count === 4 ? count : null;
  }, 8000);

  const episodeOpen = await cdp.evaluate(`(async () => {
    const row = document.querySelector('.episode-row');
    const id = row.dataset.id;
    row.click();
    await new Promise((resolve) => setTimeout(resolve, 900));
    const view = document.getElementById('playerView');
    const video = document.getElementById('playerVideo');
    const next = document.getElementById('playerNext');
    return {
      ok: !view.hidden,
      id,
      title: document.getElementById('playerTitle').textContent,
      subtitle: document.getElementById('playerSubtitle').textContent,
      nextHidden: next.hidden,
      nextTitle: next.title,
      readyState: video.readyState,
      src: video.getAttribute('src'),
      activeElement: document.activeElement ? document.activeElement.id : '',
    };
  })()`, { awaitPromise: true });

  check(
    'Al pulsar un episodio se abre el reproductor',
    episodeOpen.ok && episodeOpen.title === 'La llegada',
    JSON.stringify(episodeOpen),
  );
  check(
    'El reproductor identifica la serie, temporada y episodio',
    episodeOpen.subtitle.includes('La casa del faro') &&
      episodeOpen.subtitle.includes('Temporada 1') &&
      episodeOpen.subtitle.includes('Episodio 1'),
    episodeOpen.subtitle,
  );
  check(
    'El reproductor carga el vídeo local',
    episodeOpen.src &&
      episodeOpen.src.startsWith('casaflix://app/media/') &&
      episodeOpen.readyState >= 1,
    JSON.stringify({ src: episodeOpen.src, readyState: episodeOpen.readyState }),
  );
  check(
    'Se ofrece el siguiente episodio',
    episodeOpen.nextHidden === false &&
      episodeOpen.nextTitle.includes('Episodio 2') &&
      episodeOpen.nextTitle.includes('La tormenta'),
    episodeOpen.nextTitle,
  );

  await cdp.screenshot('06-reproductor-episodio.png');

  await cdp.evaluate(`(() => {
    document.getElementById('playerBack').click();
    return true;
  })()`);
  await waitFor('cierre del reproductor', async () => {
    const hidden = await cdp.evaluate("document.getElementById('playerView').hidden");
    return hidden ? true : null;
  }, 5000);

  await cdp.evaluate(`(() => {
    document.getElementById('seriesDetailBack').click();
    return true;
  })()`);
  await clickTab(cdp, 'movies');
  await waitFor('películas de nuevo', async () => {
    const count = await cdp.evaluate("document.querySelectorAll('.card').length");
    return count === 3 ? count : null;
  }, 8000);

  const movieOpen = await cdp.evaluate(`(async () => {
    const card = [...document.querySelectorAll('.card')].find(
      (candidate) => candidate.querySelector('.card-title')?.textContent === 'Atardecer en la costa',
    );
    card.click();
    await new Promise((resolve) => setTimeout(resolve, 900));
    const next = document.getElementById('playerNext');
    return {
      title: document.getElementById('playerTitle').textContent,
      subtitle: document.getElementById('playerSubtitle').textContent,
      nextHidden: next.hidden,
      readyState: document.getElementById('playerVideo').readyState,
    };
  })()`, { awaitPromise: true });

  check(
    'Las películas se reproducen sin siguiente episodio',
    movieOpen.title === 'Atardecer en la costa' &&
      movieOpen.subtitle.startsWith('Película') &&
      movieOpen.nextHidden === true &&
      movieOpen.readyState >= 1,
    JSON.stringify(movieOpen),
  );

  await cdp.evaluate(`(() => {
    document.getElementById('playerBack').click();
    return true;
  })()`);
  await waitFor('cierre del reproductor de película', async () => {
    const hidden = await cdp.evaluate("document.getElementById('playerView').hidden");
    return hidden ? true : null;
  }, 5000);
}

async function verifyContinueWatching(instance) {
  const { cdp } = instance;

  const ids = await cdp.evaluate(`(() => {
    const movie = [...document.querySelectorAll('.card')].find(
      (candidate) => candidate.querySelector('.card-title')?.textContent === 'Bosque de niebla',
    );
    return { movieId: movie.dataset.id };
  })()`);

  await clickTab(cdp, 'series');
  await waitFor('series para continuar', async () => {
    const count = await cdp.evaluate(
      "document.querySelectorAll('.series-card').length",
    );
    return count === 3 ? count : null;
  }, 8000);
  await cdp.evaluate(`(() => {
    const card = [...document.querySelectorAll('.series-card')].find(
      (candidate) => candidate.querySelector('.card-title')?.textContent === 'La casa del faro',
    );
    card.click();
    return true;
  })()`);
  await waitFor('episodios para continuar', async () => {
    const count = await cdp.evaluate("document.querySelectorAll('.episode-row').length");
    return count === 4 ? count : null;
  }, 8000);
  ids.episodeId = await cdp.evaluate(
    "document.querySelector('.episode-row').dataset.id",
  );

  await cdp.evaluate(
    `window.casaflix.saveProgress('${ids.movieId}', 5, 30)`,
    { awaitPromise: true },
  );
  await cdp.evaluate(
    `window.casaflix.saveProgress('${ids.episodeId}', 6, 30)`,
    { awaitPromise: true },
  );

  const saved = await cdp.evaluate(
    `(async () => {
      const state = await window.casaflix.getState();
      return {
        movie: state.progress['${ids.movieId}'],
        episode: state.progress['${ids.episodeId}'],
      };
    })()`,
    { awaitPromise: true },
  );
  check(
    'La posición de reproducción se guarda en el proceso principal',
    saved.movie &&
      Math.abs(saved.movie.position - 5) < 0.1 &&
      saved.episode &&
      Math.abs(saved.episode.position - 6) < 0.1,
    JSON.stringify(saved),
  );

  await reloadAndWait(
    cdp,
    "document.querySelectorAll('.media-grid .card').length === 3",
    'películas tras recargar',
  );

  await waitFor('fila Continuar viendo en Películas', async () => {
    const title = await cdp.evaluate(
      "document.querySelector('.row-title')?.textContent",
    );
    return title === 'Continuar viendo' ? true : null;
  }, 10000);
  await sleep(350);

  const moviesContinue = await cdp.evaluate(`(() => {
    const row = document.querySelector('.row');
    return {
      rows: [...document.querySelectorAll('.row-title')].map((el) => el.textContent),
      cards: [...row.querySelectorAll('.card')].map((card) => ({
        title: card.querySelector('.card-title')?.textContent || '',
        meta: card.querySelector('.card-meta')?.textContent || '',
        kind: card.dataset.kind,
      })),
      toolbar: row.querySelectorAll('.row-arrow').length,
    };
  })()`);
  check(
    'Continuar viendo aparece como primera fila en Películas',
    moviesContinue.rows[0] === 'Continuar viendo',
    JSON.stringify(moviesContinue.rows),
  );
  check(
    'En Películas solo aparece la película empezada',
    moviesContinue.cards.length === 1 &&
      moviesContinue.cards[0].title === 'Bosque de niebla' &&
      moviesContinue.cards[0].kind === 'movie',
    JSON.stringify(moviesContinue.cards),
  );
  check(
    'La tarjeta de continuar muestra el progreso',
    moviesContinue.cards[0]?.meta.includes('de') &&
      moviesContinue.toolbar === 2,
    JSON.stringify(moviesContinue.cards[0]),
  );

  await cdp.screenshot('07-continuar-peliculas.png');

  await clickTab(cdp, 'series');
  await waitFor('fila Continuar viendo en Series', async () => {
    const title = await cdp.evaluate(
      "document.querySelector('.row-title')?.textContent",
    );
    return title === 'Continuar viendo' ? true : null;
  }, 10000);
  await sleep(350);

  const seriesContinue = await cdp.evaluate(`(() => {
    const row = document.querySelector('.row');
    const cards = [...row.querySelectorAll('.card')].map((card) => ({
      title: card.querySelector('.card-title')?.textContent || '',
      meta: card.querySelector('.card-meta')?.textContent || '',
      kind: card.dataset.kind,
      id: card.dataset.id,
    }));
    return {
      cards,
      rows: [...document.querySelectorAll('.row-title')].map((el) => el.textContent),
      tags: [...row.querySelectorAll('.card-tag')].map((el) => el.textContent),
    };
  })()`);
  check(
    'En Series Continuar viendo muestra el episodio más reciente',
    seriesContinue.rows[0] === 'Continuar viendo' &&
      seriesContinue.cards.length === 1 &&
      seriesContinue.cards[0].title === 'La llegada' &&
      seriesContinue.cards[0].kind === 'episode' &&
      seriesContinue.cards[0].meta.includes('La casa del faro'),
    JSON.stringify(seriesContinue.cards),
  );
  check(
    'El episodio en curso muestra su porcentaje',
    seriesContinue.tags.some((tag) => tag.includes('Continuar')),
    JSON.stringify(seriesContinue.tags),
  );

  await cdp.screenshot('08-continuar-series.png');

  return ids;
}

async function verifyNextEpisode(instance, ids) {
  const { cdp } = instance;

  await clickTab(cdp, 'series');
  await waitFor('series para el siguiente episodio', async () => {
    const count = await cdp.evaluate(
      "document.querySelectorAll('.series-card').length",
    );
    return count === 3 ? count : null;
  }, 8000);
  await cdp.evaluate(`(() => {
    const card = [...document.querySelectorAll('.series-card')].find(
      (candidate) => candidate.querySelector('.card-title')?.textContent === 'La casa del faro',
    );
    card.click();
    return true;
  })()`);
  await waitFor('episodios para el siguiente', async () => {
    const count = await cdp.evaluate("document.querySelectorAll('.episode-row').length");
    return count === 4 ? count : null;
  }, 8000);

  // Se elimina el progreso artificial para que el episodio empiece desde cero.
  await cdp.evaluate(
    `window.casaflix.clearProgress('${ids.episodeId}')`,
    { awaitPromise: true },
  );
  await cdp.evaluate(
    `(() => { delete appState.progress['${ids.episodeId}']; return true; })()`,
  );

  await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('.episode-row')].find(
      (candidate) => candidate.dataset.id === '${ids.episodeId}',
    );
    row.click();
    return true;
  })()`);

  await waitFor('reproductor preparado', async () => {
    const state = await cdp.evaluate(`(() => {
      const video = document.getElementById('playerVideo');
      return {
        open: !document.getElementById('playerView').hidden,
        ready: video.readyState,
      };
    })()`);
    return state.open && state.ready >= 1 ? state : null;
  }, 10000);

  const resolved = await cdp.evaluate(`(async () => {
    const video = document.getElementById('playerVideo');
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          video.removeEventListener('durationchange', finish);
          resolve();
        };
        video.addEventListener('durationchange', finish);
        try { video.currentTime = 1e7; } catch {}
        window.setTimeout(finish, 2500);
      });
    }
    return { duration: video.duration };
  })()`, { awaitPromise: true });
  check(
    'El reproductor conoce la duración del episodio',
    Number.isFinite(resolved.duration) && resolved.duration > 0,
    JSON.stringify(resolved),
  );

  await cdp.evaluate(`(async () => {
    const video = document.getElementById('playerVideo');
    video.currentTime = Math.max(0, video.duration - 0.5);
    try { await video.play(); } catch {}
    return true;
  })()`, { awaitPromise: true });

  let ended = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    ended = await cdp.evaluate(`(() => {
      const video = document.getElementById('playerVideo');
      const next = document.getElementById('playerNext');
      return {
        ended: video.ended,
        time: Math.round(video.currentTime * 100) / 100,
        duration: video.duration,
        paused: video.paused,
        notice: document.getElementById('playerNotice').textContent,
        noticeHidden: document.getElementById('playerNotice').hidden,
        highlighted: next.classList.contains('is-highlighted'),
        nextHidden: next.hidden,
        title: document.getElementById('playerTitle').textContent,
      };
    })()`);
    if (ended.ended) break;
    if (attempt === 10) {
      await cdp.evaluate(`(() => {
        const video = document.getElementById('playerVideo');
        video.currentTime = Math.max(0, video.duration - 0.6);
        video.play().catch(() => {});
        return true;
      })()`);
    }
    await sleep(200);
  }

  check(
    'Al terminar el episodio se ofrece el siguiente',
    ended.noticeHidden === false &&
      ended.notice.includes('Siguiente') &&
      ended.notice.includes('Episodio 2'),
    JSON.stringify(ended),
  );
  check(
    'El botón de siguiente episodio se destaca al terminar',
    ended.highlighted === true && ended.nextHidden === false,
    JSON.stringify(ended),
  );

  await cdp.screenshot('09-fin-de-episodio.png');

  const advanced = await cdp.evaluate(`(async () => {
    document.getElementById('playerNext').click();
    await new Promise((resolve) => setTimeout(resolve, 900));
    const video = document.getElementById('playerVideo');
    const next = document.getElementById('playerNext');
    return {
      title: document.getElementById('playerTitle').textContent,
      subtitle: document.getElementById('playerSubtitle').textContent,
      highlighted: next.classList.contains('is-highlighted'),
      nextHidden: next.hidden,
      currentSrc: video.getAttribute('src'),
    };
  })()`, { awaitPromise: true });

  check(
    'El botón reproduce el siguiente episodio',
    advanced.title === 'La tormenta' &&
      advanced.subtitle.includes('Episodio 2') &&
      advanced.highlighted === false,
    JSON.stringify(advanced),
  );
  check(
    'Tras el episodio 2 se ofrece el episodio 10',
    advanced.nextHidden === false,
    JSON.stringify(advanced),
  );

  const progressAfter = await cdp.evaluate(
    `(async () => (await window.casaflix.getState()).progress['${ids.episodeId}'])()`,
    { awaitPromise: true },
  );
  check(
    'El episodio terminado deja de estar en Continuar viendo',
    !progressAfter,
    JSON.stringify(progressAfter),
  );

  await cdp.evaluate(`(() => {
    document.getElementById('playerBack').click();
    return true;
  })()`);
  await waitFor('cierre tras siguiente episodio', async () => {
    const hidden = await cdp.evaluate("document.getElementById('playerView').hidden");
    return hidden ? true : null;
  }, 5000);

  await cdp.evaluate(`(() => {
    document.getElementById('seriesDetailBack').click();
    return true;
  })()`);
}

async function verifySearch(instance) {
  const { cdp } = instance;

  await clickTab(cdp, 'movies');
  await waitFor('películas para buscar', async () => {
    const count = await cdp.evaluate("document.querySelectorAll('.card').length");
    return count >= 3 ? count : null;
  }, 8000);

  await cdp.evaluate(`(() => {
    const input = document.getElementById('searchInput');
    input.value = 'niebla';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await waitFor('resultados de búsqueda en películas', async () => {
    const title = await cdp.evaluate(
      "document.querySelector('.row-title')?.textContent",
    );
    return title === 'Resultados' ? true : null;
  }, 5000);

  const movieSearch = await cdp.evaluate(`(() => ({
    rows: [...document.querySelectorAll('.row-title')].map((el) => el.textContent),
    cards: [...document.querySelectorAll('.card-title')].map((el) => el.textContent),
    summary: document.getElementById('librarySummary').textContent,
  }))()`);
  check(
    'El buscador filtra películas por título',
    movieSearch.rows.length === 1 &&
      movieSearch.cards.length === 1 &&
      movieSearch.cards[0] === 'Bosque de niebla',
    JSON.stringify(movieSearch),
  );
  check(
    'El resumen muestra el número de resultados',
    movieSearch.summary.includes('1 resultado') &&
      movieSearch.summary.includes('niebla'),
    movieSearch.summary,
  );

  await cdp.evaluate(`(() => {
    const input = document.getElementById('searchInput');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await waitFor('películas tras limpiar búsqueda', async () => {
    const count = await cdp.evaluate("document.querySelectorAll('.card').length");
    return count >= 3 ? true : null;
  }, 5000);

  await clickTab(cdp, 'series');
  await waitFor('series para buscar', async () => {
    const count = await cdp.evaluate(
      "document.querySelectorAll('.series-card').length",
    );
    return count === 3 ? count : null;
  }, 8000);

  await cdp.evaluate(`(() => {
    const input = document.getElementById('searchInput');
    input.value = 'cosecha';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await waitFor('resultados de búsqueda en series', async () => {
    const title = await cdp.evaluate(
      "document.querySelector('.row-title')?.textContent",
    );
    return title === 'Resultados' ? true : null;
  }, 5000);

  const seriesSearch = await cdp.evaluate(`(() => ({
    cards: [...document.querySelectorAll('.series-card .card-title')].map(
      (el) => el.textContent,
    ),
    summary: document.getElementById('librarySummary').textContent,
  }))()`);
  check(
    'El buscador de Series también busca en los episodios',
    seriesSearch.cards.length === 1 && seriesSearch.cards[0] === 'Crónicas del valle',
    JSON.stringify(seriesSearch),
  );

  await cdp.evaluate(`(() => {
    const input = document.getElementById('searchInput');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await waitFor('series tras limpiar búsqueda', async () => {
    const count = await cdp.evaluate(
      "document.querySelectorAll('.series-card').length",
    );
    return count === 3 ? true : null;
  }, 5000);
}

async function verifyDiscover(instance) {
  const { cdp } = instance;

  await clickTab(cdp, 'discover');
  await waitFor('tarjetas de Descubrir', async () => {
    const count = await cdp.evaluate(
      "document.querySelectorAll('#discoverGrid .link-card').length",
    );
    return count === 5 ? true : null;
  }, 8000);

  await sleep(350);
  const discover = await cdp.evaluate(`(() => ({
    visible: !document.getElementById('discoverView').hidden,
    libraryHidden: document.getElementById('libraryView').hidden,
    links: [...document.querySelectorAll('.link-name')].map((el) => el.textContent),
    hosts: [...document.querySelectorAll('.link-host')].map((el) => el.textContent),
    offlineNoticeHidden: document.getElementById('offlineNotice').hidden,
    offlineText: document.getElementById('offlineNotice').textContent.replace(/\\s+/g, ' ').trim(),
    netLabel: document.getElementById('netLabel').textContent,
  }))()`);

  check('La pestaña Descubrir se muestra', discover.visible === true);
  check('Descubrir sustituye a la biblioteca', discover.libraryHidden === true);
  check('Se cargan los 5 enlaces de links.json', discover.links.length === 5, JSON.stringify(discover.links));
  check(
    'Los enlaces muestran su dominio',
    discover.hosts.every((host) => host.length > 3),
    JSON.stringify(discover.hosts),
  );
  check(
    'El aviso de conexión está oculto cuando hay red',
    discover.offlineNoticeHidden === true,
    discover.netLabel,
  );
  check(
    'El aviso de sin conexión tiene texto de respaldo',
    discover.offlineText.includes('biblioteca local sigue funcionando'),
    discover.offlineText,
  );

  await cdp.screenshot('10-descubrir.png');

  const offlineState = await cdp.evaluate(`(() => {
    appState.online = false;
    updateOnlineUi();
    return {
      noticeHidden: document.getElementById('offlineNotice').hidden,
      notice: document.getElementById('offlineNotice').textContent.replace(/\\s+/g, ' ').trim(),
      disabled: document.querySelectorAll('#discoverGrid .link-card.is-disabled').length,
      label: document.getElementById('netLabel').textContent,
    };
  })()`);
  await sleep(200);
  check(
    'Sin conexión se muestra el aviso en Descubrir',
    offlineState.noticeHidden === false &&
      offlineState.notice.includes('biblioteca local sigue funcionando'),
    JSON.stringify(offlineState),
  );
  check(
    'Sin conexión los enlaces quedan deshabilitados',
    offlineState.disabled === 5 && offlineState.label === 'Sin conexión',
    JSON.stringify(offlineState),
  );
  await cdp.screenshot('11-descubrir-sin-conexion.png');

  await cdp.evaluate(`(() => {
    appState.online = true;
    updateOnlineUi();
    return true;
  })()`);

  const deniedLink = await cdp.evaluate(
    "window.casaflix.openExternal('https://example.com/no-listado')",
    { awaitPromise: true },
  );
  check(
    'Solo se permite abrir enlaces incluidos en links.json',
    deniedLink && deniedLink.ok === false,
    JSON.stringify(deniedLink),
  );
}

async function main() {
  await fs.rm(USER_DATA, { recursive: true, force: true });
  await fs.rm(ARTIFACTS, { recursive: true, force: true });
  await fs.rm(FLAT, { recursive: true, force: true });
  await fs.mkdir(THUMBS, { recursive: true });
  await fs.mkdir(ARTIFACTS, { recursive: true });
  await fs.mkdir(FLAT, { recursive: true });

  const mediaStat = await fs.stat(MEDIA).catch(() => null);
  if (!mediaStat) {
    throw new Error('No existe .test-media. Ejecuta antes scripts/make-test-media.js.');
  }

  try {
    // Fase 1: carpeta plana sin Peliculas/Series para comprobar el aviso.
    await writeConfig(FLAT);
    const flatInstance = await launchApp();
    await verifyStructureCreation(flatInstance);
    const flatLogs = await stopApp();

    // Fase 2: biblioteca de prueba con Peliculas y Series.
    await writeConfig(MEDIA);
    const instance = await launchApp();
    await verifyMovies(instance);
    await verifySeries(instance);
    await verifyPlayer(instance);
    const ids = await verifyContinueWatching(instance);
    await verifyNextEpisode(instance, ids);
    await verifySearch(instance);
    await verifyDiscover(instance);

    check(
      'No hay excepciones del renderer',
      consoleErrors.length === 0,
      consoleErrors.join(' | '),
    );

    const logs = await stopApp();

    console.log('\nComprobaciones:');
    for (const result of results) {
      console.log(
        `${result.pass ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? `  [${result.detail}]` : ''}`,
      );
    }

    const relevant = [...flatLogs, ...logs].filter(
      (line) =>
        !line.includes('DevTools listening') &&
        !line.includes('Autofill') &&
        !line.includes('exit: 0'),
    );
    if (relevant.length > 0) {
      console.log('\nRegistro del proceso:');
      console.log(relevant.join('\n'));
    }

    if (failures.length > 0) {
      console.error(`\n${failures.length} comprobación(es) fallida(s):`);
      for (const failure of failures) console.error(`- ${failure}`);
      process.exitCode = 1;
    } else {
      console.log('\nTodas las comprobaciones han pasado.');
    }
  } catch (error) {
    const logs = await stopApp();
    console.error('\nError en la verificación:', error.message);
    if (results.length > 0) {
      console.log('\nComprobaciones realizadas:');
      for (const result of results) {
        console.log(
          `${result.pass ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? `  [${result.detail}]` : ''}`,
        );
      }
    }
    if (logs.length > 0) console.error(logs.join('\n'));
    process.exitCode = 1;
  }
}

main();
