// Mobile audit for the on-screen touch controls (src/core/touch.js).
//
// Boots the game in a phone-shaped, touch-capable viewport and drives it with REAL synthesized touch events over CDP,
// then asserts the game reacted — not just that the layer rendered. Chrome's device emulation is trustworthy for touch
// plumbing and layout; it is NOT trustworthy for frame rate (it runs on the desktop GPU), so this tool reports perf
// only as information and never gates on it. Real-device numbers come from playing on the phone itself.
//
// usage: node tools/mobile-lab.mjs [--url http://localhost:8490] [--w 915 --h 412] [--keep]
import puppeteer from 'puppeteer-core';
import { chromePath, gpuArgs } from './chrome.mjs';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const W = +opt('w', 915), H = +opt('h', 412);           // a typical Android phone in landscape (CSS px)
const URL = opt('url', 'http://localhost:8490') + '/?autostart=120';
const SHOT_DIR = opt('out', 'shots');

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

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
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
// The error beacon deliberately requests a path that cannot exist and relies on the dev server logging the 404 — it
// is how a device with no console reports to the machine serving it. Expected, so not counted as a bad request.
const isBeacon = (u) => u.includes('/__inkwave_error/');
page.on('response', (r) => { if (r.status() >= 400 && !isBeacon(r.url())) badUrls.push(r.status() + ' ' + r.url()); });
page.on('requestfailed', (r) => { if (!isBeacon(r.url())) badUrls.push('[failed] ' + r.url() + ' ' + (r.failure()?.errorText || '')); });

// Force the layer on so the run is deterministic whatever Chrome reports for `pointer: coarse`. The auto-detect
// result is reported separately below.
await page.evaluateOnNewDocument(() => {
  try { localStorage.setItem('inkwave.settings', JSON.stringify({ touchControls: 'on', quality: 'low' })); } catch { /* ignore */ }
});

const cdp = await page.createCDPSession();
// ---- touch helpers: one CDP connection, explicit touch points so multi-touch (move + look) is real ----------------
const active = new Map();   // id -> {x, y}
let seq = 0;
async function touchDispatch(type) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [...active.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id })) });
}
async function touchStart(x, y) { const id = ++seq; active.set(id, { x, y }); await touchDispatch('touchStart'); return id; }
async function touchMove(id, x, y) { active.set(id, { x, y }); await touchDispatch('touchMove'); }
async function touchEnd(id) { active.delete(id); await touchDispatch('touchEnd'); }
// drag in several steps: a single jump would be one big delta, which is not what a thumb does
async function drag(id, x0, y0, x1, y1, steps = 8) {
  await touchMove(id, x0, y0);
  for (let i = 1; i <= steps; i++) await touchMove(id, x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await page.goto(URL, { waitUntil: 'load', timeout: 180000 });

  // ---- 1. device detection (informational: Chrome's emulation may or may not report pointer:coarse) ---------------
  const detect = await page.evaluate(() => ({
    coarse: matchMedia('(pointer: coarse)').matches,
    maxTouch: navigator.maxTouchPoints,
    auto: window.__G?.input?.touch?.active ?? null,
  }));
  console.log(`info: pointer:coarse=${detect.coarse} maxTouchPoints=${detect.maxTouch} touch.active=${detect.auto}`);

  // ---- 2. boot into a live match ----------------------------------------------------------------------------------
  await page.waitForFunction(() => window.__inkwave?.match?.state === 'playing' && __inkwave.match.local, { timeout: 180000, polling: 200 });
  await sleep(1200);   // let the layer's update() see the live match

  const layer = await page.evaluate(() => {
    const el = document.querySelector('.iw-touch');
    if (!el) return null;
    const btns = [...el.querySelectorAll('.iw-touch__btn')].map((b) => {
      const r = b.getBoundingClientRect();
      return { name: b.textContent || 'fire', x: r.x, y: r.y, w: r.width, h: r.height, cy: r.y + r.height / 2, cx: r.x + r.width / 2, r: r.width / 2 };
    });
    return { live: el.classList.contains('is-live'), btns, w: innerWidth, h: innerHeight };
  });
  check('touch layer mounted', !!layer);
  check('layer is live during a match', layer?.live);
  check('all 8 controls present', layer?.btns.length === 8, `found ${layer?.btns.length}`);

  // ---- 3. geometry: every control fully on screen, clear of the gesture-nav edge ----------------------------------
  if (layer) {
    const outside = layer.btns.filter((b) => b.x < 0 || b.y < 0 || b.x + b.w > layer.w || b.y + b.h > layer.h);
    check('all controls on screen', outside.length === 0, outside.map((b) => b.name).join(','));
    const MIN = 20;   // ~32dp gesture-nav zone; anything closer risks a pointercancel instead of a tap
    const nearEdge = layer.btns.filter((b) => b.x < MIN || b.y < MIN || layer.w - (b.x + b.w) < MIN || layer.h - (b.y + b.h) < MIN);
    check('controls clear of the screen edge', nearEdge.length === 0, nearEdge.map((b) => `${b.name}@${Math.round(b.x)},${Math.round(b.y)}`).join(' '));
    const minR = Math.min(...layer.btns.map((b) => b.r));
    check('tap targets >= 22px radius (~44dp)', minR >= 21, `smallest radius ${minR.toFixed(1)}px`);
    // the stick zone (left) and the fire button (bottom right) must not overlap, or the thumb cannot choose
    const fire = layer.btns.find((b) => b.name === 'fire');
    check('fire button is in the right half', !!fire && fire.cx > layer.w * 0.5, fire ? `cx=${Math.round(fire.cx)} of ${layer.w}` : 'missing');
  }

  // Nothing below can run without the layer; report and stop rather than masking the real failure in a stack trace.
  if (!layer) {
    check('touch controls usable', false, 'layer missing — see the mount checks above');
    throw new Error('layer missing');
  }

  // ---- 4. look drag turns the camera ------------------------------------------------------------------------------
  const yaw0 = await page.evaluate(() => window.__G.rig.yaw);
  let id = await touchStart(W * 0.72, H * 0.45);
  await drag(id, W * 0.72, H * 0.45, W * 0.72 - 220, H * 0.45);
  await touchEnd(id);
  await sleep(120);
  const yaw1 = await page.evaluate(() => window.__G.rig.yaw);
  check('look drag turns the camera', Math.abs(yaw1 - yaw0) > 0.05, `yaw ${yaw0.toFixed(3)} -> ${yaw1.toFixed(3)}`);

  // ---- 5. fire button fires AND aims from the same thumb ----------------------------------------------------------
  const fire = layer.btns.find((b) => b.name === 'fire');
  const yawA = await page.evaluate(() => window.__G.rig.yaw);
  id = await touchStart(fire.cx, fire.cy);
  await sleep(180);
  const firing = await page.evaluate(() => ({ fire: window.__G.match.local.intent.fire, left: window.__G.input.mouse.left }));
  await drag(id, fire.cx, fire.cy, fire.cx - 140, fire.cy);
  await touchEnd(id);
  await sleep(150);
  const yawB = await page.evaluate(() => window.__G.rig.yaw);
  const stopped = await page.evaluate(() => window.__G.match.local.intent.fire);
  check('fire button sets intent.fire', firing.fire === true, JSON.stringify(firing));
  check('fire button also aims (drag from it)', Math.abs(yawB - yawA) > 0.05, `yaw ${yawA.toFixed(3)} -> ${yawB.toFixed(3)}`);
  check('releasing stops firing', stopped === false);

  // ---- 6. movement stick ------------------------------------------------------------------------------------------
  const before = await page.evaluate(() => ({ x: window.__G.match.local.pos.x, z: window.__G.match.local.pos.z }));
  id = await touchStart(W * 0.18, H * 0.62);
  await drag(id, W * 0.18, H * 0.62, W * 0.18, H * 0.62 - 90);   // push forward
  await sleep(700);
  const stick = await page.evaluate(() => ({ mx: window.__G.input.touch.mx, mz: window.__G.input.touch.mz }));
  await touchEnd(id);
  await sleep(80);
  const after = await page.evaluate(() => ({ x: window.__G.match.local.pos.x, z: window.__G.match.local.pos.z, mx: window.__G.input.touch.mx }));
  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  check('stick reports forward input', stick.mz > 0.4, JSON.stringify(stick));
  check('player actually moved', moved > 0.5, `moved ${moved.toFixed(2)} m`);
  check('releasing the stick zeroes input', Math.abs(after.mx) < 1e-6);

  // ---- 7. map toggle (must be a latch, and must not fight the camera) --------------------------------------------
  // The controls are inert unless the layer is live, so wait for it rather than racing the intro sequence.
  await page.waitForFunction(() => window.__inkwave?.touch?.enabled === true, { timeout: 30000, polling: 100 });
  const tap = async (b) => { const i = await touchStart(b.cx, b.cy); await sleep(60); await touchEnd(i); await sleep(220); };
  const mapBtn = (await page.evaluate(() => {
    const el = [...document.querySelectorAll('.iw-touch__btn')].find((x) => x.textContent === 'MAP');
    const r = el.getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  }));
  await tap(mapBtn);
  const mapOn = await page.evaluate(() => window.__G.input.touch.map);
  const mapUp = await page.evaluate(() => (window.__G.rig.mapK || 0) > 0.05);
  await tap(mapBtn);
  const mapOff = await page.evaluate(() => window.__G.input.touch.map);
  check('map button latches the map open', mapOn === true);
  check('map latch actually raises the map', mapUp === true);
  check('map button toggles it closed again', mapOff === false);

  // ---- 8. no runtime errors, and a look at the result -------------------------------------------------------------
  const pageErrors = errors.filter((e) => e.startsWith('[pageerror]'));
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  check('no failed requests', badUrls.length === 0, badUrls.slice(0, 5).join(' | '));
  if (errors.length) console.log('console errors (informational):\n  ' + errors.slice(0, 5).join('\n  '));

  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${SHOT_DIR}/mobile-lab.png` });
  console.log(`\nscreenshot: ${SHOT_DIR}/mobile-lab.png`);

  const perf = await page.evaluate(() => ({ fps: window.__inkwave.fps, perf: window.__inkwave.perf, boot: window.__inkwave.bootMs }));
  console.log(`info: fps=${perf.fps} boot=${perf.boot}ms calls=${perf.perf?.calls} tris=${perf.perf?.tris}  (emulated — informational only)`);
} catch (e) {
  check('run completed', false, e.message);
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (!opt('keep', null)) await browser.close();
  process.exit(failed.length ? 1 : 0);
}
