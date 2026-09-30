// Lighting audit renders: fixed cameras × stages × times from the REAL game (attract mode, loop frozen, bots frozen,
// a few kids placed on fixed marks, seeded ink, pinned world clock) → PNGs for before/after comparison, plus a perf
// probe per stage/time (GPU-synced frame time via debug.step + a 1-px readback, draw calls, triangles).
//
// usage: node tools/light-shots.mjs <outDir> [--only tidewater,halyard] [--time day|dusk] [--q high] [--cams hero,play]
//                                   [--perf] [--w 1600 --h 900] [--base http://localhost:8490] [--extra '{"top":{pos,look,fov}}'] [--pre "js"] [--ab "js A" "js B"]
// outputs: <outDir>/<stage>-<time>-<cam>.png, <outDir>/perf.json (with --perf)
// One headless Chrome for the whole run; always closed (also on error / SIGINT).
import puppeteer from 'puppeteer-core';
import { chromePath, gpuArgs } from './chrome.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAPS, TIMES } from '../src/config.js';

// Cameras (world metres; floor y = 0, Alpha spawns at -Z, sun in the south-west quadrant for every theme).
//   hero  = the stage-select 3/4 aerial;  play = third-person over a kid's shoulder, looking toward the sun-side lane;
//   shade = a kid standing in a big structure's shadow (form + character read in shade).
// kids: [team, x, z, yaw] dropped onto whatever is under them.
const CAMS = {
  tidewater: {
    hero: { pos: [36, 12.5, -30], look: [-3.07, 5.19, 14.95], fov: 62 },
    play: { pos: [3.3, 2.75, 29.2], look: [0.6, 1.5, 17], fov: 82 },
    kids: [[1, 2.2, 25.8, Math.PI + 0.25], [0, -1.5, 13, 0.3], [1, 'shade'], [0, 8, 4, -0.5]],
    shadeAt: { day: [0, 7, [-1.11, 2.4, 13.91]], dusk: [0, 9, [0.84, 2.4, 15.95]] },
  },
  kelpline: {
    hero: { pos: [-26, 14.5, 38], look: [6.38, 6.36, -11.85], fov: 60 },
    play: { pos: [3.3, 2.75, 31.2], look: [0.6, 1.5, 19], fov: 82 },
    kids: [[1, 2.2, 27.8, Math.PI + 0.25], [0, -1.5, 15, 0.3], [1, 'shade'], [0, 8, 4, -0.5]],
    shadeAt: { day: [-2, 8, [-3.11, 2.4, 14.91]], dusk: [7, 13, [7.84, 2.4, 19.95]] },
  },
  halyard: {
    hero: { pos: [-41, 16, -43], look: [-0.55, 6.92, 0.38], fov: 58 },
    play: { pos: [3.3, 2.75, 31.2], look: [0.6, 1.5, 19], fov: 82 },
    kids: [[1, 2.2, 27.8, Math.PI + 0.25], [0, -1.5, 15, 0.3], [1, 'shade'], [0, 8, 4, -0.5]],
    shadeAt: { day: [-15, 12, [-9.89, 2.4, 7.22]], dusk: [-4, 24, [-3.16, 2.4, 30.95]] },
  },
};
// shadeAt[time] = [x, z, camPos] pins the 'shade' kid + camera (found once by the search below with the original sun,
// so a sun tweak can't move the audit camera). Without it:
// 'shade' kid (+ the 'shade' camera when a stage gives none): the Bravo-half floor spot deepest inside a structure's
// sun shadow (physics ray toward the sun), a lit floor ~4 m away so the shadow edge is in frame, seen 3/4 from 7 m.
const args = process.argv.slice(2);
const OUT = args[0] && !args[0].startsWith('--') ? args[0] : '/private/tmp/lighting/cur';
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const flag = (k) => args.includes('--' + k);
const BASE = opt('base', 'http://localhost:8490').replace(/\/$/, '');
const W = +opt('w', 1600), H = +opt('h', 900), QUAL = opt('q', 'high');
const only = opt('only', null)?.split(',');
const camSel = opt('cams', 'hero,play,shade').split(',');
const EXTRA = JSON.parse(opt('extra', '{}'));   // exploration: {"<name>": cam} added to every stage (select with --cams)
const times = TIMES.filter((t) => !opt('time', null) || t === opt('time', null));
const stages = MAPS.filter((m) => (!only || only.includes(m.id)) && CAMS[m.id]);
mkdirSync(OUT, { recursive: true });

async function inPage(P) {
  const g = window.__inkwave, G = window.__G;
  const V = g.rig.camera.position.constructor;
  if (P.pre) await (0, eval)(P.pre);   // --pre: live tweak before the shots (e.g. a theme value, then G.env.setTheme)
  g.debug.freeze(); g.shotT = 1e9; g.attractT = -1e9; g.debug.freezeBots();
  if (g.fxHooks) g.fxHooks.enabled = false;
  for (const id of ['ui-root', 'fade']) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }
  g._setPalette({ id: 'tangerine-cobalt', a: '#ff8a14', b: '#2f5bff', names: ['Tangerine', 'Cobalt'] });
  if (g.decor && !g.decor.__ls) { const du = g.decor.update.bind(g.decor); g.decor.update = (dt) => { du(dt); for (const p of g.decor.pads || []) p.barMat.uniforms.uAlpha.value = 0.12; }; g.decor.__ls = true; }
  // kids: the first N actors go on fixed marks, the rest are hidden for good
  const ground = (x, z) => { const h = G.physics.segment(new V(x, 30, z), new V(x, -3, z)); return h.hit ? h.point.y : -9; };
  const sun = G.env.U.uSunDir.value, B = G.level.bounds;
  const lit = (x, y, z) => !G.physics.segment(new V(x, y, z), new V(x + sun.x * 80, y + sun.y * 80, z + sun.z * 80)).hit;
  const sh = new V(-sun.x, 0, -sun.z).normalize(), pp = new V(-sh.z, 0, sh.x);
  let best = null;
  const search = P.kids.some((k) => k[1] === 'shade') || (P.want.includes('shade') && !P.cams.find((c) => c[0] === 'shade'));
  if (search) for (let z = 3; z < B.maxZ - 10; z += 1) for (let x = B.minX + 4; x <= B.maxX - 4; x += 1) {
    const y = ground(x, z); if (y < -0.5) continue;
    let n = 0; for (const [dx, dz] of [[0, 0], [0.8, 0], [-0.8, 0], [0, 0.8], [0, -0.8]]) if (Math.abs(ground(x + dx, z + dz) - y) < 0.1 && !lit(x + dx, y + 0.6, z + dz)) n++;
    if (n < 4) continue;
    const ex = x + sh.x * 4.5, ez = z + sh.z * 4.5, ey = ground(ex, ez);
    const score = (Math.abs(ey - y) < 0.3 && lit(ex, ey + 0.3, ez) ? 10 : 0) - Math.abs(x) * 0.1 - Math.abs(z - 14) * 0.1;
    if (!best || score > best.s) best = { x, y, z, s: score };
  }
  if (best) {
    for (const k of P.kids) if (k[1] === 'shade') { k[1] = best.x; k[2] = best.z; k[3] = Math.atan2(sh.x, sh.z); }
    if (!P.cams.find((c) => c[0] === 'shade') && P.want.includes('shade')) {
      const look = [best.x, best.y + 1.0, best.z];
      let cam = null;
      for (const sg of [1, -1]) for (const d of [7, 5.5, 4.5]) {
        if (cam) break;
        const dir = new V().addScaledVector(sh, 0.55).addScaledVector(pp, 0.85 * sg).normalize();
        const p = [best.x + dir.x * d, best.y + 2.4, best.z + dir.z * d];
        if (!G.physics.segment(new V(...look), new V(...p)).hit) cam = p;
      }
      P.cams.push(['shade', { pos: cam || [best.x + sh.x * 6, best.y + 3, best.z + sh.z * 6], look, fov: 70 }]);
    }
  }
  G.actors.forEach((a, i) => {
    const k = P.kids.filter((kk) => typeof kk[1] === 'number').filter((kk) => kk[0] === a.team)[G.actors.filter((b, j) => j < i && b.team === a.team).length];
    if (!k) { a.character.setVisible(false); a.character.setVisible = function () { this.visible = false; this.root.visible = false; }; if (!a.alive) a.respawnTimer = 1e9; return; }
    a.alive = true; a.hp = 100; a.respawnTimer = 1e9;
    a.spawnAt(new V(k[1], ground(k[1], k[2]) + 0.02, k[2]), k[3]); a.invuln = 0;
  });
  // seeded ink: a few blobs of both teams around every kid (lighting of glossy ink, fresh + dry)
  let s = 7; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const inkUp = () => {
    G.projectiles.clear(); G.fx.clear?.(); G.paint.clear();
    s = 7;
    for (const k of P.kids.filter((kk) => typeof kk[1] === 'number')) for (let n = 0; n < 7; n++) {
      const x = k[1] + (rnd() - 0.5) * 7, z = k[2] + (rnd() - 0.5) * 7;
      G.paint.splat(new V(x, ground(x, z) + 0.05, z), 0.7 + rnd() * 1.1, rnd() < 0.55 ? k[0] : 1 - k[0], { seed: rnd() * 1000 });
    }
  };
  const out = { spot: best && [best.x, best.z, P.cams.find((c) => c[0] === 'shade')?.[1]] };
  for (const [name, c] of P.cams) {
    const pos = new V(...c.pos), look = new V(...c.look);
    G.settings.fov = c.fov;
    const aim = () => { g.rig.trauma = 0; g.rig._traumaIn = 0; g.rig.cinematic(pos, pos, look, look, 1e6); };
    inkUp(); aim();
    g.debug.step(1500);
    aim(); G.time = 40; G.env.time = 40; if (g.decor) g.decor.time = 40;
    g.debug.step(34);
    out[name] = G.renderer.domElement.toDataURL('image/png');
    if (P.perf && name === 'play') {
      const gl = G.renderer.getContext(), px = new Uint8Array(4);
      const t = []; for (let i = 0; i < 48; i++) { const t0 = performance.now(); g.debug.step(16.7); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); t.push(performance.now() - t0); }
      t.sort((a, b) => a - b);
      const inf = G.renderer.info.render;
      out.perf = { frameMedian: +t[t.length >> 1].toFixed(2), frameP10: +t[Math.floor(t.length * 0.1)].toFixed(2), calls: inf.calls, tris: inf.triangles, renderEma: +g.perf.render.toFixed(2) };
    }
  }
  if (P.ab) {   // --ab "<js A>" "<js B>": interleaved A/B frame timing at the play camera (same page → same GPU load)
    const c = P.cams.find((x) => x[0] === 'play')?.[1] || P.cams[0][1];
    g.rig.cinematic(new V(...c.pos), new V(...c.pos), new V(...c.look), new V(...c.look), 1e6);
    const gl = G.renderer.getContext(), px = new Uint8Array(4), T = { A: [], B: [] };
    for (let r = 0; r < 6; r++) for (const k of ['A', 'B']) {
      (0, eval)(P.ab[k === 'A' ? 0 : 1]); g.debug.step(50);
      for (let i = 0; i < 16; i++) { const t0 = performance.now(); g.debug.step(16.7); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); T[k].push(performance.now() - t0); }
    }
    const med = (a) => +a.sort((x, y) => x - y)[a.length >> 1].toFixed(2);
    out.ab = { A: med(T.A), B: med(T.B) };
  }
  return out;
}

const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: 'new',
  args: gpuArgs([`--window-size=${W},${H}`]),
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
const kill = () => { try { browser.process()?.kill('SIGKILL'); } catch { /* gone */ } };
process.on('SIGINT', () => { kill(); process.exit(130); });
process.on('SIGTERM', () => { kill(); process.exit(143); });
const perf = {};
try {
  for (const m of stages) for (const time of times) {
    const page = await browser.newPage();
    const logs = [];
    page.on('console', (e) => { const t = e.type(); if (t === 'error' || t === 'warn' || t === 'warning') logs.push(`[${t}] ${e.text()}`); });
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
    // deterministic boot: seeded Math.random (same kid styles / bot roster / attract state on every run)
    await page.evaluateOnNewDocument(() => { let a = 0x9e3779b9; Math.random = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; });
    await page.evaluateOnNewDocument((q) => {
      try { const k = 'inkwave.settings'; const s = JSON.parse(localStorage.getItem(k) || '{}') || {}; localStorage.setItem(k, JSON.stringify({ ...s, quality: q, fovMode: 'h', shadows: true, bloom: true })); } catch { /* */ }
    }, QUAL);
    const t0 = Date.now();
    await page.goto(`${BASE}/?map=${m.id}&time=${time}&skipTitle&shadercheck`, { waitUntil: 'load', timeout: 180000 });
    await page.waitForFunction("window.__inkwave && __inkwave.menus && __inkwave.menus.current === 'main' && window.__G && __G.level && __G.env && __G.actors && __G.actors.length", { timeout: 180000, polling: 250 });
    const C = { ...CAMS[m.id], ...EXTRA };
    C.kids = C.kids.map((k) => [...k]);
    const pin = C.shadeAt?.[time];
    if (pin) {
      for (const k of C.kids) if (k[1] === 'shade') { k[1] = pin[0]; k[2] = pin[1]; k[3] = 0.8; }
      C.shade = { pos: pin[2], look: [pin[0], 1, pin[1]], fov: 70 };
    }
    const res = await page.evaluate(inPage, { cams: camSel.filter((n) => C[n]).map((n) => [n, C[n]]), want: camSel, kids: C.kids, perf: flag('perf'), pre: opt('pre', null), ab: args.includes('--ab') ? [args[args.indexOf('--ab') + 1], args[args.indexOf('--ab') + 2]] : null });
    const spot = res.spot, ab = res.ab; delete res.spot; delete res.ab;
    if (ab) console.log(`  A/B frame ms (median, GPU-synced): ${JSON.stringify(ab)}`);
    for (const [n, url] of Object.entries(res)) if (n !== 'perf') writeFileSync(join(OUT, `${m.id}-${time}-${n}.png`), Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
    if (res.perf) perf[`${m.id}-${time}`] = res.perf;
    console.log(`${m.id}/${time}: ${Object.keys(res).filter((n) => n !== 'perf').join(' ')} (${((Date.now() - t0) / 1000).toFixed(1)} s)${res.perf ? ' perf ' + JSON.stringify(res.perf) : ''}${spot ? ' shade spot ' + JSON.stringify(spot) : ''}`);
    const shown = logs.filter((l) => !/favicon|preload|GPU stall|ReadPixels|WebGL-|404/.test(l));
    if (shown.length) console.log('  ' + shown.slice(0, 10).join('\n  '));
    await page.close();
  }
  if (flag('perf')) writeFileSync(join(OUT, 'perf.json'), JSON.stringify(perf, null, 1));
} finally {
  await browser.close().catch(() => {});
  kill();
}
