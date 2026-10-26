'use strict';

// Genera build/icon.png con la marca original de CasaFlix (casa + play).
// Uso: npx electron scripts/make-icon.js

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

async function main() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await win.loadURL('data:text/html,<meta charset="utf-8"><body></body>');

  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(0, 0, size, size, 112);
    ctx.clip();

    const background = ctx.createLinearGradient(0, 0, size, size);
    background.addColorStop(0, '#151d2a');
    background.addColorStop(0.55, '#0b111a');
    background.addColorStop(1, '#06090e');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, size, size);

    const glow = ctx.createRadialGradient(120, 90, 10, 120, 90, 430);
    glow.addColorStop(0, 'rgba(255, 138, 101, 0.26)');
    glow.addColorStop(1, 'rgba(255, 138, 101, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(6, 6, size - 12, size - 12, 106);
    ctx.stroke();
    ctx.restore();

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Tejado.
    ctx.beginPath();
    ctx.moveTo(108, 276);
    ctx.lineTo(256, 140);
    ctx.lineTo(404, 276);
    ctx.strokeStyle = '#ff8a65';
    ctx.lineWidth = 30;
    ctx.stroke();

    // Muros y suelo.
    ctx.beginPath();
    ctx.moveTo(150, 252);
    ctx.lineTo(150, 402);
    ctx.lineTo(362, 402);
    ctx.lineTo(362, 252);
    ctx.strokeStyle = '#f4ede4';
    ctx.lineWidth = 30;
    ctx.stroke();

    // Ventana de reproducción.
    ctx.beginPath();
    ctx.roundRect(211, 290, 116, 96, 18);
    ctx.fillStyle = 'rgba(255, 138, 101, 0.14)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 138, 101, 0.5)';
    ctx.lineWidth = 5;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(252, 316);
    ctx.lineTo(303, 338);
    ctx.lineTo(252, 360);
    ctx.closePath();
    ctx.fillStyle = '#ff8a65';
    ctx.fill();

    return canvas.toDataURL('image/png');
  })()`, true);

  const target = path.join(__dirname, '..', 'build', 'icon.png');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, Buffer.from(String(dataUrl).split(',')[1], 'base64'));
  console.log(`Icono generado en ${target}`);
  win.destroy();
  app.quit();
}

app.whenReady().then(main).catch((error) => {
  console.error(error);
  app.exit(1);
});
