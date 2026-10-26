import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronPath = require('electron');

const ROOT = path.resolve('.');
const USER_DATA = path.join(ROOT, '.test-userdata');
const MEDIA = path.join(ROOT, '.test-media');
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

async function waitForThumbFiles(minimum, timeout = 25000) {
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

async function main() {
  await fs.rm(USER_DATA, { recursive: true, force: true });
  await fs.rm(ARTIFACTS, { recursive: true, force: true });
  await fs.mkdir(THUMBS, { recursive: true });
  await fs.mkdir(ARTIFACTS, { recursive: true });

  const mediaStat = await fs.stat(MEDIA).catch(() => null);
  if (!mediaStat) {
    throw new Error('No existe .test-media. Ejecuta antes scripts/make-test-media.js.');
  }

  await fs.writeFile(
    path.join(USER_DATA, 'config.json'),
    JSON.stringify({ videoRoot: MEDIA }, null, 2),
    'utf8',
  );

  const { child, logs } = startApp();
  let cdp = null;
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });

  const cleanup = async () => {
    if (cdp) {
      await cdp.evaluate('window.close()', { awaitPromise: false }).catch(() => {});
      cdp.ws.close();
    }
    await sleep(1200);
    if (!exited) {
      child.kill();
      await sleep(600);
    }
    if (!exited) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    }
  };

  try {
    const target = await getPageTarget();
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);

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

    await waitFor('tarjetas iniciales', async () => {
      const count = await cdp.evaluate(
        "document.querySelectorAll('.card').length",
      );
      return count === 5 ? count : null;
    });

    await waitFor('carátulas cargadas', async () => {
      const state = await cdp.evaluate(`(() => {
        const posters = [...document.querySelectorAll('.card-img')].filter(
          (img) => img.dataset.source === 'poster',
        );
        return {
          count: posters.length,
          loaded: posters.filter((img) => img.complete && img.naturalWidth > 0).length,
        };
      })()`);
      return state.count === 3 && state.loaded === 3 ? state : null;
    }, 10000);

    const initial = await cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.row')].map((row) => ({
        title: row.querySelector('.row-title')?.textContent || '',
        count: row.querySelectorAll('.card').length,
      }));
      const images = [...document.querySelectorAll('.card-img')];
      return {
        title: document.title,
        rows,
        cards: [...document.querySelectorAll('.card-title')].map((el) => el.textContent),
        summary: document.getElementById('librarySummary').textContent,
        statusCount: document.getElementById('statusCount').textContent,
        statusFolder: document.getElementById('statusFolder').textContent,
        emptyHidden: document.getElementById('emptyState').hidden,
        loadingHidden: document.getElementById('loadingState').hidden,
        posters: images.filter((img) => img.dataset.source === 'poster').length,
        thumbs: images.filter((img) => img.dataset.source === 'thumb').length,
        posterLoaded: images.filter(
          (img) => img.dataset.source === 'poster' && img.complete && img.naturalWidth > 0,
        ).length,
        brokenVisible: images.filter(
          (img) => !img.hidden && img.complete && img.naturalWidth === 0,
        ).length,
        bodyOverflow: getComputedStyle(document.body).overflow,
      };
    })()`);

    check('La ventana carga el título CasaFlix', initial.title === 'CasaFlix', initial.title);
    check('Se muestran 5 tarjetas', initial.cards.length === 5, String(initial.cards.length));
    check(
      'Las categorías de primer nivel son filas',
      JSON.stringify(initial.rows.map((row) => row.title)) ===
        JSON.stringify(['Cortos', 'Naturaleza', 'Viajes', 'Sin categoría']),
      JSON.stringify(initial.rows),
    );
    check(
      'Los vídeos anidados heredan la categoría',
      initial.rows.find((row) => row.title === 'Viajes')?.count === 1 &&
        initial.rows.find((row) => row.title === 'Cortos')?.count === 1,
      JSON.stringify(initial.rows),
    );
    check(
      'El vídeo suelto aparece en Sin categoría',
      initial.rows.find((row) => row.title === 'Sin categoría')?.count === 1,
    );
    check('Se usan folder.jpg/poster.jpg como carátulas', initial.posters === 3, String(initial.posters));
    check('Las carátulas se cargan', initial.posterLoaded === 3, String(initial.posterLoaded));
    check('No hay imágenes rotas visibles', initial.brokenVisible === 0, String(initial.brokenVisible));
    check('La biblioteca no muestra el estado vacío', initial.emptyHidden === true);
    check('El estado de carga desaparece', initial.loadingHidden === true);
    check(
      'El resumen indica 5 vídeos y 4 categorías',
      initial.summary.includes('5 vídeos') && initial.summary.includes('4 categorías'),
      initial.summary,
    );
    check(
      'La barra de estado muestra la carpeta',
      initial.statusCount === '5 vídeos' && initial.statusFolder.includes('.test-media'),
      `${initial.statusCount} | ${initial.statusFolder}`,
    );

    await cdp.screenshot('01-biblioteca.png');

    // Recorre las tarjetas para activar la generación perezosa de miniaturas.
    await cdp.evaluate(
      `(async () => {
        for (const card of document.querySelectorAll('.card')) {
          card.scrollIntoView({ block: 'center', inline: 'center' });
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
        document.querySelector('.main').scrollTop = 0;
        for (const track of document.querySelectorAll('.row-track')) track.scrollLeft = 0;
        return true;
      })()`,
      { awaitPromise: true },
    );

    const thumbFiles = await waitForThumbFiles(2);
    check('Se generan miniaturas de los vídeos sin carátula', thumbFiles.length >= 2, thumbFiles.join(', '));

    const thumbStats = await Promise.all(
      thumbFiles.map(async (file) => (await fs.stat(path.join(THUMBS, file))).size),
    );
    check(
      'Las miniaturas tienen contenido',
      thumbStats.every((size) => size > 1000),
      thumbStats.join(', '),
    );

    await waitFor('miniaturas cargadas en la interfaz', async () => {
      const count = await cdp.evaluate(
        "[...document.querySelectorAll('.card-img')].filter((img) => img.dataset.source === 'thumb' && img.complete && img.naturalWidth > 0).length",
      );
      return count >= 2 ? count : null;
    });

    await waitFor('fin de la generación de miniaturas', async () => {
      const pending = await cdp.evaluate(
        "document.querySelectorAll('.thumb-work').length",
      );
      return pending === 0 ? true : null;
    }, 25000);

    const afterThumbs = await cdp.evaluate(`(() => {
      const images = [...document.querySelectorAll('.card-img')];
      return {
        thumbs: images.filter((img) => img.dataset.source === 'thumb').length,
        loaded: images.filter((img) => img.complete && img.naturalWidth > 0 && !img.hidden).length,
        broken: images.filter((img) => !img.hidden && img.complete && img.naturalWidth === 0).length,
        summary: document.getElementById('librarySummary').textContent,
      };
    })()`);
    check('La interfaz usa las miniaturas generadas', afterThumbs.thumbs === 2, String(afterThumbs.thumbs));
    check('Todas las tarjetas visibles tienen imagen', afterThumbs.broken === 0, String(afterThumbs.broken));

    await cdp.screenshot('02-biblioteca-miniaturas.png');

    // Buscador por título.
    await cdp.evaluate(`(() => {
      const input = document.getElementById('searchInput');
      input.value = 'niebla';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await waitFor('resultados de búsqueda', async () => {
      const title = await cdp.evaluate(
        "document.querySelector('.row-title')?.textContent",
      );
      return title === 'Resultados' ? true : null;
    }, 5000);
    const searchState = await cdp.evaluate(`(() => ({
      rows: [...document.querySelectorAll('.row-title')].map((el) => el.textContent),
      cards: [...document.querySelectorAll('.card-title')].map((el) => el.textContent),
      summary: document.getElementById('librarySummary').textContent,
    }))()`);
    check(
      'El buscador filtra por título',
      searchState.rows.length === 1 &&
        searchState.rows[0] === 'Resultados' &&
        searchState.cards.length === 1 &&
        searchState.cards[0] === 'Bosque de niebla',
      JSON.stringify(searchState),
    );
    check(
      'El resumen muestra el número de resultados',
      searchState.summary.includes('1 resultado') && searchState.summary.includes('niebla'),
      searchState.summary,
    );

    await cdp.evaluate(`(() => {
      const input = document.getElementById('searchInput');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await waitFor('biblioteca tras limpiar búsqueda', async () => {
      const count = await cdp.evaluate("document.querySelectorAll('.card').length");
      return count === 5 ? true : null;
    }, 5000);

    // Reproductor.
    const playerOpen = await cdp.evaluate(`(async () => {
      const card = [...document.querySelectorAll('.card')].find(
        (candidate) => candidate.querySelector('.card-title')?.textContent === 'Bienvenida',
      );
      if (!card) return { ok: false, reason: 'card-not-found' };
      const id = card.dataset.id;
      card.click();
      await new Promise((resolve) => setTimeout(resolve, 800));
      const view = document.getElementById('playerView');
      const video = document.getElementById('playerVideo');
      const style = getComputedStyle(video);
      return {
        ok: !view.hidden,
        id,
        title: document.getElementById('playerTitle').textContent,
        subtitle: document.getElementById('playerSubtitle').textContent,
        readyState: video.readyState,
        paused: video.paused,
        duration: String(video.duration),
        src: video.getAttribute('src'),
        outline: style.outline,
        border: style.border,
        boxShadow: style.boxShadow,
        activeElement: document.activeElement ? document.activeElement.id : '',
      };
    })()`, { awaitPromise: true });

    check('Al pulsar una tarjeta se abre el reproductor', playerOpen.ok === true, JSON.stringify(playerOpen));
    check(
      'El reproductor carga el vídeo local',
      playerOpen.title === 'Bienvenida' &&
        playerOpen.src &&
        playerOpen.src.startsWith('casaflix://app/media/') &&
        playerOpen.readyState >= 1,
      JSON.stringify(playerOpen),
    );

    await cdp.evaluate(`(async () => {
      const video = document.getElementById('playerVideo');
      try { await video.play(); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 700));
      video.pause();
      return true;
    })()`, { awaitPromise: true });
    await cdp.screenshot('03-reproductor.png');

    await cdp.evaluate(`(() => {
      document.getElementById('playerBack').click();
      return true;
    })()`);
    await waitFor('cierre del reproductor', async () => {
      const hidden = await cdp.evaluate("document.getElementById('playerView').hidden");
      return hidden ? true : null;
    }, 5000);

    // Guarda una posición de prueba y recarga para comprobar Continuar viendo.
    await cdp.evaluate(
      `window.casaflix.saveProgress('${playerOpen.id}', 6, 30)`,
      { awaitPromise: true },
    );
    const progressSaved = await cdp.evaluate(
      `(async () => (await window.casaflix.getState()).progress['${playerOpen.id}'])()`,
      { awaitPromise: true },
    );
    check(
      'La posición de reproducción se guarda en el proceso principal',
      progressSaved && Math.abs(progressSaved.position - 6) < 0.1,
      JSON.stringify(progressSaved),
    );

    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor('biblioteca recargada', async () => {
      const count = await cdp.evaluate("document.querySelectorAll('.card').length");
      return count >= 5 ? true : null;
    }, 30000);

    await waitFor('miniatura de Continuar viendo cargada', async () => {
      const loaded = await cdp.evaluate(`(() => {
        const card = document.querySelector('.card[data-id="${playerOpen.id}"]');
        const img = card?.querySelector('.card-img');
        return Boolean(img && img.complete && img.naturalWidth > 0);
      })()`);
      return loaded ? true : null;
    }, 10000);
    await sleep(350);

    const continueState = await cdp.evaluate(`(() => {
      const result = {
        rows: [...document.querySelectorAll('.row-title')].map((el) => el.textContent),
        tags: [...document.querySelectorAll('.card-tag')].map((el) => el.textContent),
        bars: document.querySelectorAll('.card-progress').length,
      };
      return result;
    })()`);
    check(
      'Aparece la fila Continuar viendo',
      continueState.rows[0] === 'Continuar viendo',
      JSON.stringify(continueState.rows),
    );
    check(
      'La tarjeta de continuar muestra el progreso',
      continueState.tags.some((tag) => tag.includes('Continuar')) && continueState.bars >= 1,
      JSON.stringify(continueState),
    );
    await cdp.screenshot('04-continuar-viendo.png');

    // Descubrir.
    await cdp.evaluate(`(() => {
      document.querySelector('.tab[data-view="discover"]').click();
      return true;
    })()`);
    await waitFor('tarjetas de Descubrir', async () => {
      const count = await cdp.evaluate(
        "document.querySelectorAll('#discoverGrid .link-card').length",
      );
      return count === 5 ? true : null;
    }, 8000);

    await sleep(350);
    const discover = await cdp.evaluate(`(() => ({
      visible: !document.getElementById('discoverView').hidden,
      links: [...document.querySelectorAll('.link-name')].map((el) => el.textContent),
      hosts: [...document.querySelectorAll('.link-host')].map((el) => el.textContent),
      offlineNoticeHidden: document.getElementById('offlineNotice').hidden,
      offlineText: document.getElementById('offlineNotice').textContent.replace(/\\s+/g, ' ').trim(),
      netLabel: document.getElementById('netLabel').textContent,
    }))()`);

    check('La pestaña Descubrir se muestra', discover.visible === true);
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

    await cdp.screenshot('05-descubrir.png');

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
    await cdp.screenshot('06-descubrir-sin-conexion.png');

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

    check(
      'No hay excepciones del renderer',
      consoleErrors.length === 0,
      consoleErrors.join(' | '),
    );

    await cleanup();
    cdp = null;

    console.log('\nComprobaciones:');
    for (const result of results) {
      console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? `  [${result.detail}]` : ''}`);
    }

    if (logs.length > 0) {
      const relevant = logs.filter(
        (line) => !line.includes('DevTools listening') && !line.includes('Autofill'),
      );
      if (relevant.length > 0) {
        console.log('\nRegistro del proceso:');
        console.log(relevant.join('\n'));
      }
    }

    if (failures.length > 0) {
      console.error(`\n${failures.length} comprobación(es) fallida(s):`);
      for (const failure of failures) console.error(`- ${failure}`);
      process.exitCode = 1;
    } else {
      console.log('\nTodas las comprobaciones han pasado.');
    }
  } catch (error) {
    await cleanup();
    console.error('\nError en la verificación:', error.message);
    if (results.length > 0) {
      console.log('\nComprobaciones realizadas:');
      for (const result of results) {
        console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? `  [${result.detail}]` : ''}`);
      }
    }
    if (logs.length > 0) console.error(logs.join('\n'));
    process.exitCode = 1;
  }
}

main();
