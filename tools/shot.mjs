// Headless screenshot/audit helper.
// usage: node tools/shot.mjs <url> <out.png> [--w 1600] [--h 900] [--wait 2500] [--eval "js expr"] [--evalAfter "js"] [--waitAfter 1000]
// Prints console errors/warnings from the page. Uses the system Chrome with GPU (ANGLE/Metal) so WebGL renders.
import puppeteer from 'puppeteer-core';
import { chromePath, gpuArgs } from './chrome.mjs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const url = args[0];
const out = args[1] || 'shot.png';
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const W = +opt('w', 1600), H = +opt('h', 900);
const wait = +opt('wait', 2500);
const evalJs = opt('eval', null);
const evalAfter = opt('evalAfter', null);
const waitAfter = +opt('waitAfter', 800);

const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: 'new',
  args: gpuArgs([`--window-size=${W},${H}`]),
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => { const t = m.type(); if (t === 'error' || t === 'warning' || t === 'warn' || process.env.ALLLOGS) logs.push(`[${t}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${(e.stack || '').split('\n').slice(0, 4).join('\n')}`));
await page.goto(url, { waitUntil: 'load', timeout: 180000 });
const until = opt('until', url.includes('/tools/') ? null : 'window.__inkwave');
if (until) { try { await page.waitForFunction(until, { timeout: 180000, polling: 200 }); } catch (e) { logs.push('[until timeout] ' + until); } }
await new Promise((r) => setTimeout(r, wait));
if (evalJs) {
  try { const r = await page.evaluate(evalJs); if (r !== undefined) console.log('eval ->', typeof r === 'string' ? r : JSON.stringify(r)); }
  catch (e) { logs.push('[eval error] ' + e.message); }
}
if (evalAfter) {
  await new Promise((r) => setTimeout(r, waitAfter));
  try { const r = await page.evaluate(evalAfter); if (r !== undefined) console.log('evalAfter ->', typeof r === 'string' ? r : JSON.stringify(r)); }
  catch (e) { logs.push('[evalAfter error] ' + e.message); }
  await new Promise((r) => setTimeout(r, waitAfter));
}
mkdirSync(dirname(out), { recursive: true });
await page.screenshot({ path: out });
console.log('saved', out);
if (logs.length) console.log(logs.slice(0, 40).join('\n'));
await browser.close();
