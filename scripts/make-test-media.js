'use strict';

// Genera un conjunto de vídeos WebM originales para probar CasaFlix.
// Uso: npx electron scripts/make-test-media.js
// Los archivos se crean en .test-media/ (ignorada por git).

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const ROOT = path.join(__dirname, '..', '.test-media');

const CLIPS = [
  {
    file: 'Naturaleza/Atardecer en la costa.webm',
    title: 'Atardecer en la costa',
    subtitle: 'CasaFlix · vídeo de prueba',
    palette: ['#ff8a65', '#5b2c3a', '#151018'],
    durationMs: 5000,
  },
  {
    file: 'Naturaleza/Bosque de niebla.webm',
    title: 'Bosque de niebla',
    subtitle: 'CasaFlix · vídeo de prueba',
    palette: ['#2a8d84', '#123a3f', '#081014'],
    durationMs: 16000,
  },
  {
    file: 'Viajes/2026/Ruta por la montaña.webm',
    title: 'Ruta por la montaña',
    subtitle: 'CasaFlix · vídeo de prueba',
    palette: ['#b39144', '#4b3a17', '#120f08'],
    durationMs: 6000,
  },
  {
    file: 'Cortos/Serie/Clip anidado.webm',
    title: 'Clip anidado',
    subtitle: 'CasaFlix · vídeo de prueba',
    palette: ['#7858a3', '#2a1f42', '#0d0a14'],
    durationMs: 5000,
  },
  {
    file: 'Bienvenida.webm',
    title: 'Bienvenida',
    subtitle: 'CasaFlix · vídeo de prueba',
    palette: ['#4b7fb8', '#182b42', '#080d14'],
    durationMs: 5000,
  },
];

const POSTERS = [
  {
    file: 'Naturaleza/folder.jpg',
    title: 'Naturaleza',
    subtitle: 'Carátula folder.jpg',
    palette: ['#2a8d84', '#0d2a2d'],
  },
  {
    file: 'Cortos/Serie/poster.jpg',
    title: 'Cortos',
    subtitle: 'Carátula poster.jpg',
    palette: ['#7858a3', '#211735'],
  },
];

function recorderSource(config) {
  return `(async () => {
    const cfg = ${JSON.stringify(config)};
    const canvas = document.createElement('canvas');
    canvas.width = cfg.width;
    canvas.height = cfg.height;
    const ctx = canvas.getContext('2d');
    const started = performance.now();

    function draw(now) {
      const progress = Math.max(0, Math.min(1, (now - started) / cfg.durationMs));
      const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      gradient.addColorStop(0, cfg.palette[0]);
      gradient.addColorStop(0.55, cfg.palette[1]);
      gradient.addColorStop(1, cfg.palette[2]);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.save();
      ctx.globalAlpha = 0.12;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      for (let x = -canvas.height; x < canvas.width; x += 48) {
        ctx.beginPath();
        ctx.moveTo(x + 120, 0);
        ctx.lineTo(x + 120 + canvas.height, canvas.height);
        ctx.stroke();
      }
      ctx.restore();

      const cx = 90 + (canvas.width - 180) * progress;
      const cy = canvas.height * 0.64 + Math.sin(progress * Math.PI * 2) * 26;
      ctx.beginPath();
      ctx.arc(cx, cy, 62, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, 34, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.fill();

      ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
      ctx.font = '700 42px "Segoe UI", sans-serif';
      ctx.fillText(cfg.title, 52, 112);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
      ctx.font = '500 18px "Segoe UI", sans-serif';
      ctx.fillText(cfg.subtitle, 54, 146);

      ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.fillRect(52, canvas.height - 38, canvas.width - 104, 5);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.fillRect(52, canvas.height - 38, (canvas.width - 104) * progress, 5);
    }

    draw(started);

    const stream = canvas.captureStream(30);
    const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mimeType = candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 900000 } : {});
    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.start(250);

    let frameId = 0;
    const loop = (now) => {
      draw(now);
      frameId = requestAnimationFrame(loop);
    };
    frameId = requestAnimationFrame(loop);

    await new Promise((resolve) => setTimeout(resolve, cfg.durationMs));
    recorder.stop();
    await stopped;
    cancelAnimationFrame(frameId);
    stream.getTracks().forEach((track) => track.stop());

    const blob = new Blob(chunks, { type: 'video/webm' });
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  })()`;
}

function posterSource(config) {
  return `(async () => {
    const cfg = ${JSON.stringify(config)};
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, cfg.palette[0]);
    gradient.addColorStop(1, cfg.palette[1]);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    for (let i = -720; i < 1280; i += 72) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i + 720, 720);
      ctx.stroke();
    }
    ctx.restore();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.font = '700 86px "Segoe UI", sans-serif';
    ctx.fillText(cfg.title, 82, 340);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.font = '500 32px "Segoe UI", sans-serif';
    ctx.fillText(cfg.subtitle, 86, 396);

    ctx.beginPath();
    ctx.arc(1060, 160, 96, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(1060, 160, 44, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.fill();

    return canvas.toDataURL('image/jpeg', 0.86);
  })()`;
}

async function saveDataUrl(dataUrl, target) {
  const base64 = String(dataUrl).split(',')[1];
  if (!base64) throw new Error(`No se pudo generar ${target}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, Buffer.from(base64, 'base64'));
}

async function main() {
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(ROOT, { recursive: true });

  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadURL('data:text/html,<meta charset="utf-8"><body></body>');

  for (const clip of CLIPS) {
    process.stdout.write(`Grabando ${clip.file}… `);
    const dataUrl = await win.webContents.executeJavaScript(
      recorderSource({ ...clip, width: 640, height: 360 }),
      true,
    );
    await saveDataUrl(dataUrl, path.join(ROOT, clip.file));
    console.log('ok');
  }

  for (const poster of POSTERS) {
    process.stdout.write(`Creando ${poster.file}… `);
    const dataUrl = await win.webContents.executeJavaScript(
      posterSource(poster),
      true,
    );
    await saveDataUrl(dataUrl, path.join(ROOT, poster.file));
    console.log('ok');
  }

  await fs.mkdir(path.join(ROOT, 'Vacía'), { recursive: true });
  await fs.writeFile(
    path.join(ROOT, 'Naturaleza', 'notas.txt'),
    'Este archivo no es un vídeo y no debe aparecer en la biblioteca.\n',
    'utf8',
  );

  win.destroy();
  console.log(`\nContenido generado en ${ROOT}`);
  app.quit();
}

app.whenReady().then(main).catch((error) => {
  console.error(error);
  app.exit(1);
});
