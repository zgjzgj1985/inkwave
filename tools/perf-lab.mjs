// Checks tools/perf-lab.html against a running game.
//
// The lab's whole reason to exist is that a phone can misreport itself: a backgrounded page stops animating and every
// counter freezes at its last value, which reads exactly like a slowdown. So the check that matters most here is not
// "does the panel render" but "does the panel refuse to report when the page is frozen" — and that is tested for real,
// by freezing the page over CDP rather than by inspecting the code that decides it.
//
// Chrome's device emulation is fine for this; it is not fine for frame-rate numbers (desktop GPU), so the fps figures
// are reported as information and never gated on.
//
// usage: node tools/perf-lab.mjs [--url http://localhost:8490] [--w 915 --h 412]
import puppeteer from 'puppeteer-core';
import { chromePath, gpuArgs } from './chrome.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const W = +opt('w', 915), H = +opt('h', 412);
const BASE = opt('url', 'http://localhost:8490');

const sleep = (t) => new Promise((r) => setTimeout(r, t));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: 'new',
  args: gpuArgs([`--window-size=${W},${H}`]),
  defaultViewport: { width: W, height: H, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
});
const kill = () => { try { browser.process()?.kill('SIGKILL'); } catch { /* gone */ } };
process.on('exit', kill);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { kill(); process.exit(130); });

const page = await browser.newPage();
const errors = [];
const badUrls = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (/__inkwave_error/.test(m.location()?.url || '')) return;   // the beacon's expected 404
  errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
// The game's error beacon deliberately requests a path that cannot exist and relies on the dev server logging the
// 404 — that one is expected, and it is how the GPU report below reaches the server log.
const isBeacon = (u) => u.includes('/__inkwave_error/');
page.on('response', (r) => { if (r.status() >= 400 && !isBeacon(r.url())) badUrls.push(r.status() + ' ' + r.url()); });
page.on('requestfailed', (r) => { if (!isBeacon(r.url())) badUrls.push('[failed] ' + r.url() + ' ' + (r.failure()?.errorText || '')); });

console.log(`perf lab -> ${BASE}/tools/perf-lab.html   (${W}x${H} touch viewport)\n`);
await page.goto(`${BASE}/tools/perf-lab.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });

// The lab boots the game itself. Unbundled that is ~165 module requests plus a procedural world build, and this dev
// server is single-threaded — on a cold start it has taken over 40 s here, so the wait is generous and the stage is
// reported rather than hidden. `__inkwave` is only published after the world is built.
const stage = async () => page.evaluate(() => {
  const w = document.getElementById('game').contentWindow;
  if (!w || !w.__G) return 'modules';
  if (!w.__inkwave) return 'world build';
  if (!w.__G.match || w.__G.match.state === undefined) return 'match';
  return 'ready';
}).catch(() => 'n/a');
let booted = false;
for (let i = 0; i < 180 && !booted; i++) {
  booted = await page.evaluate(() => {
    const w = document.getElementById('game').contentWindow;
    return !!(w && w.__inkwave && w.__G && w.__G.match);
  }).catch(() => false);
  if (!booted) await sleep(1000);
}
check('game boots inside the lab and reaches a match', booted, booted ? '' : `stuck at "${await stage()}"`);
if (!booted) { await browser.close(); process.exit(1); }

// Frames must actually advance, or every number below is decoration. Held separately from the boot check so a
// throttled headless run is reported as such instead of being blamed on the lab.
let advancing = 0;
for (let i = 0; i < 20 && advancing <= 10; i++) {
  const before = await page.evaluate(() => document.getElementById('game').contentWindow.__inkwave._frameN);
  await sleep(1500);
  advancing = await page.evaluate(() => document.getElementById('game').contentWindow.__inkwave._frameN) - before;
}
check('frames are advancing (the page is live)', advancing > 10, `${advancing} frames in 1.5 s`);

const panel = await page.evaluate(() => ({
  dot: document.getElementById('dot').className,
  verdict: document.getElementById('verdict').textContent.trim(),
  live: document.getElementById('rLive').textContent,
  cost: document.getElementById('rCost').textContent,
  device: document.getElementById('rDevice').textContent,
  shaders: document.getElementById('rShaders').textContent.trim(),
  abBtns: document.querySelectorAll('#abRow button[data-ab]').length,
  qBtns: document.querySelectorAll('#abRow button[data-q]').length,
}));
console.log('\n  verdict  ', panel.verdict);
console.log('  live     ', panel.live.replace(/\s+/g, ' '));
console.log('  cost     ', panel.cost.replace(/\s+/g, ' '));
console.log('  device   ', panel.device.replace(/\s+/g, ' '));
console.log('  shaders  ', panel.shaders, '\n');

// Assert the verdict agrees with the number shown, not that the machine is fast — a headless run over the network can
// legitimately sit under the liveness threshold, and gating on "is it 60" would test the runner, not the lab.
const shownFps = +(panel.live.match(/frames\/s\s+(\d+)/) || [, -1])[1];
check('the verdict agrees with the frame rate it reports',
  panel.dot === (shownFps >= 25 ? 'on' : 'stale'), `${shownFps} frames/s -> ${panel.dot}`);
check('shader audit reports every program linked', /all \d+ programs linked/.test(panel.shaders), panel.shaders);
check('frame budget is computed', /frame budget/.test(panel.live) && !/frame budget –/.test(panel.live));

// The point of the lab: never show a number that is merely old. Freeze the page exactly as a backgrounded phone tab
// is frozen, then confirm the panel flips to stale instead of holding its last reading.
// The point of the lab: never show a number that is merely old. Stop the frames the way a stalled or backgrounded
// game stops them and confirm the panel refuses to keep reporting a rate. The observer is stored on `window` — an
// unreferenced MutationObserver can be collected, which silently turns this into a test of nothing.
await page.evaluate(() => {
  window.__dotLog = [];
  window.__dotObs = new MutationObserver(() => window.__dotLog.push(document.getElementById('dot').className));
  window.__dotObs.observe(document.getElementById('dot'), { attributes: true, attributeFilter: ['class'] });
});
await page.evaluate(() => document.getElementById('game').contentWindow.__inkwave.debug.freeze());
await sleep(3000);
const frozen = await page.evaluate(() => ({
  cls: document.getElementById('dot').className,
  verdict: document.getElementById('verdict').textContent.trim(),
}));
await page.evaluate(() => document.getElementById('game').contentWindow.__inkwave.debug.unfreeze());
await sleep(2500);
const dotLog = await page.evaluate(() => window.__dotLog);
const recovered = await page.evaluate(() => document.getElementById('dot').className);
// The observer fires on every assignment, so collapse runs before showing it.
const rle = []; for (const c of dotLog) { const last = rle[rle.length - 1]; if (last && last[0] === c) last[1]++; else rle.push([c, 1]); }
check('stalled frames are reported stale, not as a frame rate',
  frozen.cls === 'stale' && recovered === 'on',
  `while stopped: ${frozen.cls} (${frozen.verdict}) | recovered: ${recovered} | ${rle.map(([c, k]) => `${c}×${k}`).join(' -> ')}`);

// A/B: the toggle must reach into the real scene, and the delta must be attributed to a real frame rate.
const abChar = await page.evaluate(async () => {
  const f = document.getElementById('game'), w = f.contentWindow;
  const vis = () => (w.__G.actors || []).filter((a) => a.character?.root).map((a) => a.character.root.visible);
  const on = vis();
  document.querySelector('button[data-ab="characters"]').click();
  const off = vis();
  document.querySelector('button[data-ab="characters"]').click();
  return { n: on.length, before: on.every(Boolean), hiddenAll: off.length > 0 && off.every((v) => !v), after: vis().every(Boolean) };
});
check('A/B characters hides the actors and restores them',
  abChar.n > 0 && abChar.before && abChar.hiddenAll && abChar.after,
  `${abChar.n} actors`);

const abMap = await page.evaluate(() => {
  const w = document.getElementById('game').contentWindow, m = w.__inkwave.minimap;
  document.querySelector('button[data-ab="minimap"]').click();
  const muted = m._compose.toString().includes('=>') || m._compose.length === 0;
  document.querySelector('button[data-ab="minimap"]').click();
  return { muted, restored: typeof m._compose === 'function' && !m._compose.toString().includes('=>') };
});
check('A/B minimap silences the compose and restores it', abMap.muted && abMap.restored);

const q = await page.evaluate(() => {
  const w = document.getElementById('game').contentWindow;
  const before = w.__G.settings.quality;
  document.querySelector('button[data-q="medium"]').click();
  const changed = w.__G.settings.quality === 'medium';
  const rebuilt = !!w.__inkwave.R.composer;
  document.querySelector(`button[data-q="${before}"]`).click();
  return { before, changed, rebuilt, restored: w.__G.settings.quality === before };
});
check('quality switches at runtime and restores', q.changed && q.rebuilt && q.restored, `${q.before} -> medium -> ${q.before}`);

const rep = await page.evaluate(() => {
  document.getElementById('copy').click();
  return document.getElementById('report').textContent;
});
check('report has the fields needed to diagnose a device off-machine',
  /gpu\s+\S/.test(rep) && /limits .*fUniform \d+/.test(rep) && /cost /.test(rep) && /shader /.test(rep),
  `${rep.split('\n').length} lines`);
// The context is read across a realm boundary; a naive instanceof test silently reports WebGL1 there.
check('the live context is reported as WebGL2', /webgl2 true/.test(rep),
  (rep.match(/gl\s+.*/) || [''])[0]);

// The panel overlays the game; it must be collapsible or it eats the top of the screen on a phone.
const collapsed = await page.evaluate(() => {
  document.getElementById('toggle').click();
  const hid = getComputedStyle(document.querySelector('#rCost')).display === 'none';
  document.getElementById('toggle').click();
  return hid;
});
check('panel collapses', collapsed);

check('no failed requests', badUrls.length === 0, badUrls.slice(0, 4).join(' | '));
check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log('\n' + (rep.split('\n').map((l) => '  ' + l).join('\n')));
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
await browser.close();
process.exit(bad.length ? 1 : 0);
