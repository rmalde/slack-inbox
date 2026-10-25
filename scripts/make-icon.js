'use strict';
// Renders build/icon-1024.png + build/icon.icns from inline SVG (run: npm run make-icon).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
    <stop offset="0" stop-color="#8c86ff"/><stop offset="0.55" stop-color="#5d57e6"/><stop offset="1" stop-color="#3a33b5"/>
  </linearGradient>
  <linearGradient id="tray" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e9e7ff"/>
  </linearGradient>
  <filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#1c1470" flood-opacity="0.35"/></filter>
</defs>
<rect x="100" y="100" width="824" height="824" rx="190" fill="url(#bg)"/>
<rect x="100" y="100" width="824" height="824" rx="190" fill="none" stroke="#ffffff" stroke-opacity="0.18" stroke-width="4"/>
<g filter="url(#s)">
  <rect x="300" y="268" width="424" height="250" rx="48" fill="#ffffff" fill-opacity="0.38"/>
  <rect x="268" y="318" width="488" height="250" rx="52" fill="#ffffff" fill-opacity="0.6"/>
  <path d="M236 520 Q236 470 286 470 L410 470 Q432 470 442 490 L462 528 Q472 548 494 548 L530 548 Q552 548 562 528 L582 490 Q592 470 614 470 L738 470 Q788 470 788 520 L788 700 Q788 756 732 756 L292 756 Q236 756 236 700 Z" fill="url(#tray)"/>
</g>
<circle cx="742" cy="300" r="64" fill="#ff8a3d" stroke="#5d57e6" stroke-width="22"/>
</svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${SVG}</body></html>`));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const build = path.join(__dirname, '..', 'build');
  const png = path.join(build, 'icon-1024.png');
  fs.writeFileSync(png, img.resize({ width: 1024, height: 1024 }).toPNG());
  const set = path.join(build, 'icon.iconset');
  fs.mkdirSync(set, { recursive: true });
  for (const s of [16, 32, 128, 256, 512]) {
    for (const k of [1, 2]) {
      const px = s * k;
      const name = `icon_${s}x${s}${k === 2 ? '@2x' : ''}.png`;
      execFileSync('/usr/bin/sips', ['-z', String(px), String(px), png, '--out', path.join(set, name)], { stdio: 'ignore' });
    }
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', set, '-o', path.join(build, 'icon.icns')]);
  console.log('wrote', png);
  app.quit();
});
