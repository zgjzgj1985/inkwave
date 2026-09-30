// Scripted play-through for audits.
// usage: node tools/play.mjs <url> <script.json|inline-json> [--w 1600 --h 900]
// script: [{"wait":ms},{"down":"KeyW"},{"up":"KeyW"},{"press":"Space"},{"mouse":"down"|"up"},{"move":[dx,dy]},
//          {"shot":"/path.png"},{"eval":"js"},{"evalFile":"/path.js"},{"log":"label"}]
import puppeteer from 'puppeteer-core';
import { chromePath, gpuArgs } from './chrome.mjs';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const url = args[0];
const raw = args[1];
const steps = JSON.parse(existsSync(raw) ? readFileSync(raw, 'utf8') : raw);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const W = +opt('w', 1600), H = +opt('h', 900);

const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: 'new',
  args: gpuArgs([`--window-size=${W},${H}`]),
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});
// always take the browser down with us (an orphaned headless Chrome keeps spinning its WebGL loop at 100 % CPU)
const kill = () => { try { browser.process()?.kill('SIGKILL'); } catch { /* gone */ } };
process.on('exit', kill);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { kill(); process.exit(130); });
const watchdog = setTimeout(() => { console.log('play.mjs WATCHDOG — giving up'); kill(); process.exit(2); }, +(opt('timeout', 900)) * 1000);
watchdog.unref?.();
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => { const t = m.type(); if (t === 'error' || t === 'warn' || t === 'warning' || process.env.ALLLOGS) logs.push(`[${t}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${(e.stack || '').split('\n').slice(0, 5).join('\n')}`));
try {
await page.goto(url, { waitUntil: 'load', timeout: 180000 });
for (const s of steps) {
  if (s.until) { try { await page.waitForFunction(s.until, { timeout: 180000, polling: 150 }); } catch { console.log('until timeout', s.until); } }
  if (s.wait) await new Promise((r) => setTimeout(r, s.wait));
  if (s.down) await page.keyboard.down(s.down);
  if (s.up) await page.keyboard.up(s.up);
  if (s.press) await page.keyboard.press(s.press);
  if (s.mouse === 'down') await page.mouse.down();
  if (s.mouse === 'up') await page.mouse.up();
  if (s.click) await page.mouse.click(s.click[0], s.click[1]);
  if (s.evalFile) s.eval = readFileSync(s.evalFile, 'utf8');   // longer audit scripts live in their own .js file
  if (s.eval) { try { const r = await page.evaluate(s.eval); if (r !== undefined) console.log((s.log || 'eval') + ' ->', typeof r === 'string' ? r : JSON.stringify(r)); } catch (e) { console.log('eval error', e.message); } }
  if (s.shot) { mkdirSync(dirname(s.shot), { recursive: true }); await page.screenshot({ path: s.shot }); console.log('shot', s.shot); }
}
} catch (e) { console.log('play.mjs error', e.message); }
if (logs.length) console.log(logs.filter((l) => !/404|preload/.test(l)).slice(0, 40).join('\n'));
await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
kill();
process.exit(0);
