// Frame-time benchmark for the game.
//
// The desktop runs vsync-capped, which makes every optimisation invisible: 7 ms of work and 1 ms of work both report
// 57 fps. This runs with the cap off and the adaptive resolution pinned, so the number it prints is the actual cost
// of a frame and a change can be seen in it. Reports the mean, p50/p90/worst, and the sim/render/tail split.
//
// usage: node tools/bench.mjs [--url http://localhost:8492] [--secs 12] [--quality low] [--label baseline]
import puppeteer from 'puppeteer-core';
import { chromePath, benchArgs } from './chrome.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const BASE = opt('url', 'http://localhost:8492');
const SECS = +opt('secs', 12);
const QUALITY = opt('quality', 'low');
const LABEL = opt('label', 'bench');

const sleep = (t) => new Promise((r) => setTimeout(r, t));
const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: 'new',
  args: benchArgs(['--window-size=915,412']),
  defaultViewport: { width: 915, height: 412, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

await page.goto(`${BASE}/?autostart=600&autopilot&nofullscreen&quality=${QUALITY}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
for (let i = 0; i < 120; i++) {
  await sleep(1000);
  if (await page.evaluate(() => window.__inkwave?.match?.state === 'playing').catch(() => false)) break;
}
await sleep(8000);                       // past the first frames, where every shader compiles

// Pin the resolution and stop the adaptive controller, or it silently trades pixels for frame time and hides the very
// thing being measured.
await page.evaluate(() => {
  const g = window.__inkwave;
  g._dynRes = () => {};
  g.R.setDynamicScale(1);
});

const r = await page.evaluate(async (secs) => {
  const g = window.__inkwave;
  const ft = [];
  let arcFrames = 0, mapFrames = 0, last = performance.now(), lastN = g._frameN;
  const t0 = performance.now();
  while (performance.now() - t0 < secs * 1000) {
    await new Promise((res) => requestAnimationFrame(res));
    const now = performance.now();
    // A path only measured if it was exercised: report which optional per-frame work was actually live.
    if (g.projectiles?.arcLine?.visible) arcFrames++;
    if (g.match?.local?.mapHeld) mapFrames++;
    // one sample per rendered frame, straight off the game's own frame counter
    if (g._frameN !== lastN) { lastN = g._frameN; ft.push(now - last); last = now; }
  }
  ft.sort((a, b) => a - b);
  const pct = (p) => ft[Math.min(ft.length - 1, Math.floor(ft.length * p))];
  const p = g.perf;
  return {
    n: ft.length,
    mean: ft.reduce((a, b) => a + b, 0) / ft.length,
    p50: pct(0.5), p90: pct(0.9), worst: ft[ft.length - 1],
    fps: ft.length / ((performance.now() - t0) / 1000),
    sim: p.sim, render: p.render, tail: p.tail, minimap: p.minimap,
    calls: p.calls, tris: p.tris, arcFrames, mapFrames,
  };
}, SECS);

const f = (v, d = 2) => v.toFixed(d);
console.log(`\n  ${LABEL}  (${QUALITY}, vsync off, dynScale pinned at 1)`);
console.log(`  frame ms   mean ${f(r.mean)}   p50 ${f(r.p50)}   p90 ${f(r.p90)}   worst ${f(r.worst)}`);
console.log(`  fps        ${f(r.fps, 1)}   (${r.n} frames sampled)`);
console.log(`  cpu split  sim ${f(r.sim)}  render ${f(r.render)}  tail ${f(r.tail)}  minimap ${f(r.minimap)}   = ${f(r.sim + r.render + r.tail)} ms`);
console.log(`  scene      ${r.calls} calls, ${r.tris.toLocaleString()} tris`);
console.log(`  exercised  throw-arc ${Math.round((r.arcFrames / r.n) * 100)}% of frames, map held ${Math.round((r.mapFrames / r.n) * 100)}%`);
if (errs.length) console.log(`  page errors: ${errs.slice(0, 3).join(' | ')}`);
await browser.close();
