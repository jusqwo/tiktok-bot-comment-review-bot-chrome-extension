// Renders the extension icon (an SVG) to PNGs with headless Chrome. Run once: node test/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { launch } from './cdp.mjs';
const svg = (s) => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#111114"/>
  <path d="M32 9 L51 16 V31 C51 43 43 51 32 56 C21 51 13 43 13 31 V16 Z" fill="#ff3b5c"/>
  <path d="M23 32 L29.5 38.5 L42 25" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
const b = await launch();
const p = await b.page();
for (const s of [16, 48, 128]) {
  await p.send('Emulation.setDeviceMetricsOverride', { width: s, height: s, deviceScaleFactor: 1, mobile: false });
  await p.send('Page.navigate', { url: 'data:text/html,' + encodeURIComponent(`<style>html,body{margin:0;background:transparent}</style>${svg(s)}`) });
  await new Promise((r) => setTimeout(r, 400));
  await p.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  const { data } = await p.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: s, height: s, scale: 1 } });
  writeFileSync(new URL(`../extension/icon${s}.png`, import.meta.url), Buffer.from(data, 'base64'));
}
await b.close();
console.log('icons written');
