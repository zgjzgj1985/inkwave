// Stage-select art: one hero shot per stage × time of day, rendered from the REAL game — attract mode
// booted on the stage, every actor hidden, ink / projectiles / FX cleared, a static cinematic camera, a fixed world
// clock — then captured straight from the WebGL canvas (no DOM UI) at 2× supersampling and saved as WebP.
//
// usage: node tools/stage-shots.mjs [--only halyard[,kelpline]] [--time day|dusk] [--out assets/stages] [--scratch]
//                                   [--dsf 2] [--cams cams.json|'{json}'] [--no-contact] [--base http://localhost:8490]
//   --only     stage ids (comma separated); default: every stage in MAPS (new stages are picked up automatically)
//   --time     one time of day; default: every entry of TIMES
//   --out      output folder (default assets/stages); manifest.json there lists every stage × time file present
//   --scratch  write to /private/tmp/menus/stages/ instead of --out (iterate on cameras without touching assets/)
//   --dsf      supersampling = device scale factor: the game renders 1920×1080 × dsf and the frame is downsampled
//              (default 2 → 3840×2160; use 1.5 if the GPU struggles)
//   --cams     camera exploration: {"<stage>": [cam, ...]} (cam as in SHOTS below, or { pos, dir: [yaw°, pitch°],
//              fov }) renders every candidate of each stage into /private/tmp/menus/stages/explore/ plus one numbered
//              sheet per stage × time
//   --verbose  print every console error/warning from the game pages (default hides known capture noise)
// outputs: <out>/<id>-<time>.webp (1920×1080, q ≈ 0.86, kept ≤ ~350 KB), <out>/<id>-<time>-sm.webp (640×360,
//          q ≈ 0.82), <out>/manifest.json, and a review sheet /private/tmp/menus/stages/contact.png (the crop of the
//          ~1100×520 `object-fit: cover` hero panel is shown undimmed; everything outside it is dimmed).
import puppeteer from 'puppeteer-core';
import { chromePath, gpuArgs } from './chrome.mjs';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAPS, TIMES, TEAM_PALETTES } from '../src/config.js';

// ------------------------------------------------------------------------------------------------ camera table
// World metres: arena floor y = 0, sea y = -1.6, Team Alpha spawns at -Z. The sun sits in the west / south-west for
// every theme (day az 222° el 43°, golden 194°/28°, sunset 206°/15° — az measured from +X toward +Z), the city skyline
// + ferris wheel lie east (+X), the container port with its cranes south-east, the suspension bridge north-west.
//   pos / look  camera position and look-at point. Day and dusk use the SAME camera (the stage-select UI cross-fades
//               between them, so the two images must line up exactly).
//   orbit       optional instead of pos: [azimuth°, elevation°, distance] of the camera around `look`
//   fov         horizontal field of view (degrees, 16:9 — the game's settings.fov)
//   t           world clock (s) for the shot: water, clouds, gulls, sailboats, blinking lights are identical by day
//               and at dusk
//   palette     team palette id (config TEAM_PALETTES) for the team-coloured set dressing (banners, bunting, pads)
// The hero panel shows the middle ~2.2:1 band of the 16:9 frame (object-fit: cover), so keep the subject between
// ~10 % and ~90 % of the frame height.
// All three: a low 3/4 aerial (camera 12.5–16 m up, 7–9° down, horizon ≈ 25–32 % from the top) from just outside a
// corner of the arena, each looking at a different backdrop landmark with the sun to the side or behind (never into
// it — at dusk that blows out the sea and the floor).
const SHOTS = {
  // Tidewater Plaza — from off the Alpha kiosk corner (SE) looking NW over the tiled plaza: Bravo's lavender deck +
  // palm in the foreground, the central tower mid-frame, the INKWAVE spawn wall at the back, the suspension bridge
  // spanning the bay behind. Sun from the right (golden rim at dusk, bridge lights on).
  tidewater: { pos: [36, 12.5, -30], look: [-3.07, 5.19, 14.95], fov: 62, t: 40, palette: 'tangerine-cobalt' },
  // Kelpline Terminal — from off the Bravo yard (NW) looking SE: the steel gantry deck over the trench + grate bridges
  // mid-frame, KRAKEN container stacks and the Alpha spawn wall behind, the container port's three cranes right above
  // it. Sun from the left. (Height keeps Bravo's teal container at (-10.2, 23) just below the bottom edge.)
  kelpline: { pos: [-26, 14.5, 38], look: [6.38, 6.36, -11.85], fov: 60, t: 40, palette: 'tangerine-cobalt' },
  // Halyard Marina — from over the water west of the Alpha quay looking NE along the ferry: KRAKEN LINES hull side,
  // wheelhouse + funnel centred, both tugs on blocks flanking it, the Alpha houseboat in front, the Bravo clubhouse
  // (HALYARD MARINA sign) back right, the city skyline across the bay (windows lit at dusk). Sun behind-left.
  // (x/z nudged 3 m sideways so the quay palm at (-15.5, -38.5) stays out of the bottom-left corner.)
  halyard: { pos: [-41, 16, -43], look: [-0.55, 6.92, 0.38], fov: 58, t: 40, palette: 'tangerine-cobalt' },
  // Cargo Terminal — over the gate-side shoulder of the Alpha base looking up the turned berth: K7's portal over the
  // Landing, the stacks either side of the truck lane, CORAL MAXIMA's bow (the layout's own `art` camera, in world space)
  cargo: { pos: [11.3, 26, -64.07], look: [-0.98, 4, 5.57], fov: 60, t: 40, palette: 'tangerine-cobalt' },
};
// A stage missing from the table gets a generic 3/4 aerial from its layout bounds (computed in the page).
const FALLBACK = { pos: null, look: null, fov: 60, t: 40, palette: 'tangerine-cobalt' };

// ------------------------------------------------------------------------------------------------ options
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = '/private/tmp/menus/stages';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const flag = (k) => args.includes('--' + k);
const BASE = opt('base', 'http://localhost:8490').replace(/\/$/, '');
const DSF = +opt('dsf', 2);
const W = 1920, H = 1080, SW = 640, SH = 360;
const Q_BIG = 0.86, Q_SM = 0.82, MAX_BIG = 350 * 1024;
const outOpt = opt('out', 'assets/stages');
const OUT = flag('scratch') ? SCRATCH : (isAbsolute(outOpt) ? outOpt : resolve(ROOT, outOpt));
const only = opt('only', null)?.split(',').map((s) => s.trim()).filter(Boolean);
const timeOpt = opt('time', null);
const camsOpt = opt('cams', null);
const EXPLORE = camsOpt ? JSON.parse(existsSync(camsOpt) ? readFileSync(camsOpt, 'utf8') : camsOpt) : null;

const stages = MAPS.filter((m) => (!only || only.includes(m.id)) && (!EXPLORE || EXPLORE[m.id]));
const times = TIMES.filter((t) => !timeOpt || t === timeOpt);
if (only) for (const id of only) if (!MAPS.find((m) => m.id === id)) console.warn(`unknown stage "${id}" (MAPS: ${MAPS.map((m) => m.id).join(', ')})`);
if (!stages.length || !times.length) { console.error('nothing to render'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kb = (n) => `${Math.round(n / 1024)} KB`;
const DEG = Math.PI / 180;

// resolve a table / exploration entry into a concrete camera (pos may stay null → generic fallback in the page)
function camFor(c) {
  const cam = { ...FALLBACK, ...c };
  if (cam.dir && cam.pos) {   // exploration: [yaw°, pitch°] from pos (yaw from +X toward +Z, pitch < 0 looks down)
    const [yaw, pitch] = cam.dir;
    cam.look = [cam.pos[0] + Math.cos(pitch * DEG) * Math.cos(yaw * DEG) * 60, cam.pos[1] + Math.sin(pitch * DEG) * 60, cam.pos[2] + Math.cos(pitch * DEG) * Math.sin(yaw * DEG) * 60];
  }
  if (cam.orbit && cam.look) {
    const [az, el, d] = cam.orbit;
    cam.pos = [cam.look[0] + Math.cos(el * DEG) * Math.cos(az * DEG) * d, cam.look[1] + Math.sin(el * DEG) * d, cam.look[2] + Math.cos(el * DEG) * Math.sin(az * DEG) * d];
  }
  cam.paletteObj = TEAM_PALETTES.find((p) => p.id === cam.palette) || TEAM_PALETTES[0];
  return cam;
}

// ------------------------------------------------------------------------------------------------ in-page capture
// Runs inside the game page. Freezes the live loop, cleans the frame, then for each camera: settle at the camera,
// re-clean, pin the world clock, render ONE frame via debug.step and grab the drawing buffer in the same task
// (preserveDrawingBuffer is off — the buffer is only valid until the frame is composited).
async function captureInPage(P) {
  const g = window.__inkwave, G = window.__G;
  const V = g.rig.camera.position.constructor;
  g.debug.freeze();
  g.shotT = 1e9;              // attract director never cuts to another shot
  g.attractT = -1e9;          // ... and never restarts the attract round
  g.debug.freezeBots();
  // every actor hidden for good (respawns call setVisible(true)); nobody splatted may respawn (drop-in splash) either
  for (const a of G.actors) {
    const c = a.character;
    c.setVisible(false);
    c.setVisible = function () { this.visible = false; this.root.visible = false; };
    if (!a.alive) a.respawnTimer = 1e9;
  }
  if (g.fxHooks) g.fxHooks.enabled = false;   // no ambient sea spray / feathers / trails
  // spawn barriers glow when an enemy stands near them — hidden bots must not change the look
  if (g.decor && !g.decor.__stageShot) {
    const du = g.decor.update.bind(g.decor);
    g.decor.update = (dt) => { du(dt); for (const p of g.decor.pads || []) p.barMat.uniforms.uAlpha.value = 0.12; };
    g.decor.__stageShot = true;
  }
  for (const id of ['ui-root', 'fade']) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }
  const clean = () => { G.projectiles.clear(); G.fx.clear?.(); G.paint.clear(); };
  const B = G.level.bounds;
  const out = [];
  let lastPal = null;
  for (const cam of P.cams) {
    if (cam.paletteObj && cam.paletteObj.id !== lastPal) { g._setPalette(cam.paletteObj); lastPal = cam.paletteObj.id; }
    const pos = cam.pos ? new V(...cam.pos) : new V(B.minX - 0.6 * (B.maxX - B.minX), 0.3 * (B.maxZ - B.minZ), B.minZ * 0.6);
    const look = cam.look ? new V(...cam.look) : new V(0, 0, (B.minZ + B.maxZ) / 2);
    G.settings.fov = cam.fov;
    const aim = () => { g.rig.trauma = 0; g.rig._traumaIn = 0; g.rig.cinematic(pos, pos, look, look, 1e6); };
    clean(); aim();
    g.debug.step(P.settleMs);                  // water, clouds, paint atlas, shadows settle at this camera
    // final frame: re-clean, pin the clock (day + dusk identical), render once; if anything inked the floor in those
    // two sim frames (a late charger release / slam landing from a frozen bot), clean and render again
    let inked = 0;
    for (let k = 0; k < 4; k++) {
      clean(); aim();
      G.time = cam.t; G.env.time = cam.t; if (g.decor) g.decor.time = cam.t;
      g.debug.step(34);                        // 2 sim frames, renders once
      const cov = G.paint.coverage?.() || [0, 0];
      inked = cov[0] + cov[1];
      if (!(inked > 0) && !(G.projectiles.list?.length > 0)) break;
    }
    // ---- grab + downsample (same task as the render)
    const src = G.renderer.domElement;
    const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'; return [c, x]; };
    const [big, bx] = mk(P.W, P.H);
    bx.drawImage(src, 0, 0, P.W, P.H);
    const [half, hx] = mk(P.W / 2, P.H / 2);
    hx.drawImage(big, 0, 0, P.W / 2, P.H / 2);
    const [sm, sx] = mk(P.SW, P.SH);
    sx.drawImage(half, 0, 0, P.SW, P.SH);
    const enc = (cv, q, max) => {
      for (;;) {
        const url = cv.toDataURL('image/webp', q);
        const bytes = Math.floor(((url.length - url.indexOf(',') - 1) * 3) / 4);
        if (!max || bytes <= max || q <= 0.7) return { url, q, bytes };
        q = Math.round((q - 0.02) * 100) / 100;
      }
    };
    // an all-black / all-one-colour frame means the capture failed (lost context, composited buffer)
    const probe = sx.getImageData(0, 0, P.SW, P.SH).data;
    let mn = 255, mx = 0;
    for (let i = 0; i < probe.length; i += 4 * 97) { const l = probe[i] + probe[i + 1] + probe[i + 2]; if (l < mn) mn = l; if (l > mx) mx = l; }
    out.push({
      big: enc(big, P.qBig, P.maxBig), sm: enc(sm, P.qSm, 0),
      buffer: [src.width, src.height], range: mx - mn, inked,
      pos: pos.toArray().map((v) => +v.toFixed(2)), look: look.toArray().map((v) => +v.toFixed(2)), fov: cam.fov,
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ browser
const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: 'new',
  args: gpuArgs([`--window-size=${W},${H}`]),
  defaultViewport: { width: W, height: H, deviceScaleFactor: DSF },
  protocolTimeout: 600000,
});

const READY = "window.__inkwave && __inkwave.menus && __inkwave.menus.current === 'main' && window.__G && __G.level && __G.env";

// Boot one stage × time; a boot that fails (the shared dev server may be mid-edit) is retried after a minute.
async function boot(id, time) {
  // (devstage: online-only stages — Cargo Terminal — only boot offline with the dev override)
  const url = `${BASE}/?map=${encodeURIComponent(id)}&time=${time}&skipTitle&devstage`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const page = await browser.newPage();
    const logs = [];
    page.on('console', (m) => { const t = m.type(); if (t === 'error' || t === 'warn' || t === 'warning') logs.push(`[${t}] ${m.text()}`); });
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
    // ultra quality for the run, set before any game script reads it (fresh headless profile)
    await page.evaluateOnNewDocument(() => {
      try {
        const k = 'inkwave.settings';
        const s = JSON.parse(localStorage.getItem(k) || '{}') || {};
        localStorage.setItem(k, JSON.stringify({ ...s, quality: 'ultra', fovMode: 'h', shadows: true, bloom: true }));
      } catch { /* no storage */ }
    });
    const t0 = Date.now();
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 180000 });
      await page.waitForFunction(`(${READY}) || (document.getElementById('boot-error') && document.getElementById('boot-error').style.display === 'block')`, { timeout: 180000, polling: 250 });
      const err = await page.evaluate(() => { const e = document.getElementById('boot-error'); return e && e.style.display === 'block' ? e.textContent : null; });
      if (err) throw new Error(err);
      const stub = logs.find((l) => /failed to load|using stub|prop kit failed|props failed/.test(l));
      if (stub) throw new Error('module failed to load: ' + stub.slice(0, 200));
      return { page, logs, bootMs: Date.now() - t0 };
    } catch (e) {
      console.log(`  ${id}/${time}: boot failed (${e.message.split('\n')[0]})${attempt < 3 ? ' — retrying in 60 s' : ' — giving up'}`);
      if (logs.length) console.log('    ' + logs.slice(0, 8).join('\n    '));
      await page.close().catch(() => {});
      if (attempt < 3) await sleep(60000);
    }
  }
  return null;
}

const dataOf = (url) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
// console errors/warnings from the game page (the GPU-stall/readback notices come from our own canvas capture)
const printLogs = (logs, tag) => {
  const shown = flag('verbose') ? logs : logs.filter((l) => !/favicon|preload|GPU stall|ReadPixels|WebGL-/.test(l));
  if (shown.length) console.log(`  console (${tag}):\n    ` + shown.slice(0, 20).join('\n    '));
};
const show = (f) => { const r = relative(ROOT, f); return r && !r.startsWith('..') ? r : f; };

// ------------------------------------------------------------------------------------------------ run
mkdirSync(OUT, { recursive: true });
mkdirSync(SCRATCH, { recursive: true });
const tStart = Date.now();
const results = [];
const exploreSheets = [];
for (const map of stages) {
  for (const time of times) {
    const cams = (EXPLORE ? EXPLORE[map.id] : [SHOTS[map.id] || FALLBACK]).map(camFor);
    process.stdout.write(`${map.id}/${time}: booting… `);
    const b = await boot(map.id, time);
    if (!b) { results.push({ id: map.id, time, error: 'boot failed' }); continue; }
    console.log(`ready in ${(b.bootMs / 1000).toFixed(1)} s`);
    let shots;
    const t0 = Date.now();
    try {
      shots = await b.page.evaluate(captureInPage, { cams, settleMs: 1500, W, H, SW, SH, qBig: Q_BIG, qSm: Q_SM, maxBig: MAX_BIG });
    } catch (e) {
      console.log(`  capture failed: ${e.message}`);
      printLogs(b.logs, `${map.id}/${time}`);
      await b.page.close().catch(() => {});
      results.push({ id: map.id, time, error: 'capture failed' });
      continue;
    }
    const capMs = Date.now() - t0;
    printLogs(b.logs, `${map.id}/${time}`);
    await b.page.close().catch(() => {});
    if (EXPLORE) {
      const dir = join(SCRATCH, 'explore');
      mkdirSync(dir, { recursive: true });
      const files = shots.map((s, i) => {
        const f = join(dir, `${map.id}-${time}-c${i}.webp`);
        writeFileSync(f, dataOf(s.big.url));
        console.log(`  c${i}: pos ${JSON.stringify(s.pos)} look ${JSON.stringify(s.look)} fov ${s.fov} · ${kb(s.big.bytes)}${s.range < 30 ? ' · WARNING: flat frame' : ''}`);
        return { f, label: `c${i} · pos ${s.pos.join(', ')} · look ${s.look.join(', ')} · fov ${s.fov}`, url: s.big.url };
      });
      console.log(`  capture + encode ${(capMs / 1000).toFixed(1)} s for ${shots.length} camera(s)`);
      exploreSheets.push({ name: `${map.id}-${time}-sheet.png`, files });
      continue;
    }
    const s = shots[0];
    const big = join(OUT, `${map.id}-${time}.webp`), sm = join(OUT, `${map.id}-${time}-sm.webp`);
    writeFileSync(big, dataOf(s.big.url));
    writeFileSync(sm, dataOf(s.sm.url));
    console.log(`  ${show(big)}  ${kb(s.big.bytes)} (q ${s.big.q})  ·  -sm ${kb(s.sm.bytes)} (q ${s.sm.q})  ·  buffer ${s.buffer.join('×')}  ·  capture + encode ${(capMs / 1000).toFixed(1)} s${s.range < 30 ? '  ·  WARNING: flat frame' : ''}${s.inked > 0 ? '  ·  WARNING: ink in frame' : ''}`);
    results.push({ id: map.id, time, big, sm, bytes: s.big.bytes, smBytes: s.sm.bytes, q: s.big.q, bigUrl: s.big.url, cam: { pos: s.pos, look: s.look, fov: s.fov } });
  }
}

// ------------------------------------------------------------------------------------------------ manifest
if (!EXPLORE) {
  const rel = relative(ROOT, OUT);
  const webPath = (f) => (rel && !rel.startsWith('..') ? `${rel.split('\\').join('/')}/${f}` : f);
  const manifest = {};
  for (const m of MAPS) {
    for (const t of TIMES) {
      if (!existsSync(join(OUT, `${m.id}-${t}.webp`))) continue;
      (manifest[m.id] || (manifest[m.id] = {}))[t] = { src: webPath(`${m.id}-${t}.webp`), sm: webPath(`${m.id}-${t}-sm.webp`) };
    }
  }
  manifest.generated = new Date().toISOString();
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`manifest: ${show(join(OUT, 'manifest.json'))}`);
}

// ------------------------------------------------------------------------------------------------ review sheets
// Hero-panel crop: 1100×520 with object-fit: cover shows the middle (1920 / (1100/520)) px of the 1080 px height.
const BAND = W / (1100 / 520) / H;   // ≈ 0.84 of the frame height
async function sheet(file, cells, cols, cw, thumbs) {
  const ch = Math.round((cw * 9) / 16), pad = (1 - BAND) / 2;
  const pageW = cols * (cw + 14) + 14, tw = Math.floor((pageW - 28 - 5 * 10) / 6);   // list thumbnails: 6 across
  const cell = (c) => `<figure><div class="img"><img src="${c.url}"><i style="top:0;height:${(pad * 100).toFixed(2)}%"></i><i style="bottom:0;height:${(pad * 100).toFixed(2)}%"></i></div><figcaption>${c.label}</figcaption></figure>`;
  const html = `<!doctype html><html><head><style>
    body{margin:0;background:#101217;color:#e8eaf0;font:500 15px/1.3 -apple-system,system-ui,sans-serif}
    .grid{display:grid;grid-template-columns:repeat(${cols},${cw}px);gap:14px;padding:14px}
    figure{margin:0} .img{position:relative;width:${cw}px;height:${ch}px;overflow:hidden;border-radius:6px}
    .img img{width:100%;height:100%;display:block} .img i{position:absolute;left:0;right:0;background:rgba(8,10,14,.55)}
    figcaption{padding:6px 2px 0;opacity:.85}
    .thumbs{display:flex;gap:10px;padding:0 14px 14px;flex-wrap:wrap} .thumbs figure{width:${tw}px} .thumbs figure img{width:${tw}px;height:${Math.round((tw * 9) / 16)}px;display:block;border-radius:4px}
    .thumbs figcaption{font-size:13px}
  </style></head><body><div class="grid">${cells.map(cell).join('')}</div>
  ${thumbs ? `<div class="thumbs">${thumbs.map((t) => `<figure><img src="${t.url}"><figcaption>${t.label}</figcaption></figure>`).join('')}</div>` : ''}
  </body></html>`;
  const page = await browser.newPage();
  await page.setViewport({ width: pageW, height: 400, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
  console.log(`sheet: ${file}`);
}

if (EXPLORE) {
  for (const s of exploreSheets) await sheet(join(SCRATCH, 'explore', s.name), s.files, 2, 900);
} else if (!flag('no-contact')) {
  // every stage × time present in the output folder (not just this run), day | dusk per row, + the list thumbnails
  const cells = [], thumbs = [];
  for (const m of MAPS) {
    for (const t of TIMES) {
      const f = join(OUT, `${m.id}-${t}.webp`), fs = join(OUT, `${m.id}-${t}-sm.webp`);
      if (!existsSync(f)) continue;
      cells.push({ url: 'data:image/webp;base64,' + readFileSync(f).toString('base64'), label: `${m.name} · ${t} · ${kb(statSync(f).size)}` });
      if (existsSync(fs)) thumbs.push({ url: 'data:image/webp;base64,' + readFileSync(fs).toString('base64'), label: `${m.id}-${t}-sm · ${kb(statSync(fs).size)}` });
    }
  }
  if (cells.length) await sheet(join(SCRATCH, 'contact.png'), cells, 2, 960, thumbs);
}

await browser.close();
const failed = results.filter((r) => r.error);
console.log(`done in ${((Date.now() - tStart) / 1000).toFixed(1)} s${failed.length ? ` — FAILED: ${failed.map((r) => `${r.id}/${r.time} (${r.error})`).join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
