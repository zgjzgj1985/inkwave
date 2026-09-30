// Deterministic video reel recorder.
// usage: node tools/reel.mjs <url> <spec.js> <outDir> [--w 1600 --h 900 --fps 30 --only 0,3,5 --mode canvas|shot
//                                                     --until "js" --preWait ms]
// The spec is a page-side script that defines window.REEL = { init(), segs: [{ order, title, sub, dur, ... }],
// begin(i) → meta, frame(i, f, fps) → JPEG dataURL (canvas mode) or null (shot mode: the page is screenshotted) }.
// Frames land in <outDir>/seg-<order>/f-00000.jpg plus seg-<order>.json; tools/reel-compose.py turns them into an MP4.
import puppeteer from 'puppeteer-core';
import { chromePath, gpuArgs } from './chrome.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const [url, spec, outDir] = args;
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const W = +opt('w', 1600), H = +opt('h', 900), FPS = +opt('fps', 30);
const only = opt('only', null) ? opt('only').split(',').map(Number) : null;
const mode = opt('mode', 'canvas');
const until = opt('until', url.includes('/tools/') ? 'window.lab && window.lab.hero' : 'window.__inkwave');
const preWait = +opt('preWait', 0);
const every = +opt('every', 1);          // test mode: keep only every Nth frame (all frames are still simulated)

const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: 'new',
  args: gpuArgs([`--window-size=${W},${H}`]),
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
await page.goto(url, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(until, { timeout: 180000, polling: 200 });
if (preWait) await new Promise((r) => setTimeout(r, preWait));
await page.addScriptTag({ path: spec });
await page.evaluate(() => window.REEL.init && window.REEL.init());
const n = await page.evaluate(() => window.REEL.segs.length);
mkdirSync(outDir, { recursive: true });
const t0 = Date.now();
for (let i = 0; i < n; i++) {
  if (only && !only.includes(i)) continue;
  const meta = await page.evaluate((i) => window.REEL.begin(i), i);
  const frames = Math.round(meta.dur * FPS);
  const dir = join(outDir, `seg-${String(meta.order).padStart(3, '0')}`);
  mkdirSync(dir, { recursive: true });
  for (let f = 0; f < frames; f++) {
    const cap = f % every === 0;
    const data = await page.evaluate((i, f, fps, cap) => window.REEL.frame(i, f, fps, cap), i, f, FPS, cap);
    if (!cap) continue;
    const file = join(dir, `f-${String(f).padStart(5, '0')}.jpg`);
    if (data) writeFileSync(file, Buffer.from(data.slice(data.indexOf(',') + 1), 'base64'));
    else await page.screenshot({ path: file, type: 'jpeg', quality: 93 });
  }
  writeFileSync(join(outDir, `seg-${String(meta.order).padStart(3, '0')}.json`), JSON.stringify({ ...meta, frames, fps: FPS, dir }));
  console.log(`seg ${i} (${meta.title}) → ${frames} frames  [${((Date.now() - t0) / 1000).toFixed(0)} s]`);
}
await browser.close();
