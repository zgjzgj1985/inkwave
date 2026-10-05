// Loads the served game headless and waits long enough for the in-game perf beacon to fire, so the telemetry path is
// tested end to end rather than assumed.
import puppeteer from 'puppeteer-core';
import { chromePath, gpuArgs } from './chrome.mjs';
const url = process.argv[2];
const b = await puppeteer.launch({ executablePath: chromePath(), headless: 'new',
  args: gpuArgs(['--window-size=915,412']), defaultViewport: { width: 915, height: 412, deviceScaleFactor: 2, isMobile: true, hasTouch: true } });
const p = await b.newPage();
p.on('pageerror', (e) => console.log('  [pageerror]', e.message.slice(0, 200)));
await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const s = await p.evaluate(() => {
    const w = window;
    return { state: w.__inkwave?.match?.state, fps: w.__inkwave?.fps, sent: !!w.__inkwave?._pbSent,
             perf: w.__inkwave?.perf ? { sim: +w.__inkwave.perf.sim.toFixed(2), render: +w.__inkwave.perf.render.toFixed(2),
               tail: +w.__inkwave.perf.tail.toFixed(2), minimap: +w.__inkwave.perf.minimap.toFixed(2), maxFt: Math.round(w.__inkwave.perf.maxFt) } : null };
  }).catch(() => null);
  if (s?.sent) { console.log('beacon sent. sample:', JSON.stringify(s)); break; }
  if (i % 5 === 0) console.log(`t=${i * 2}s`, JSON.stringify(s));
}
await b.close();
