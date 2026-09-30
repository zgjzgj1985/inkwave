// Deterministic handling / camera / aim measurements.
// usage: node tools/measure-handling.mjs [--map tidewater|kelpline] [--only a,b,c] [--raw out.json]
// Drives the live game with __inkwave.debug.freeze() and manual 60 Hz frames (rendering skipped), records per-frame
// actor + camera state for scripted scenarios and prints metrics:
//   accel/stop/reverse/turn times, facing turn rates, pos.y micro-bounce (2nd difference + high-pass residual),
//   grounded flicker, camera angular jitter (high-pass residual of yaw/pitch), camera position jitter,
//   jump arcs, jump buffer / coyote, swim + climb profiles, projectile-vs-crosshair error.
import puppeteer from 'puppeteer-core';
import { chromePath, gpuArgs } from './chrome.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const MAP = opt('map', 'tidewater');
const ONLY = opt('only', '');
const RAW = opt('raw', '');
const BASE = opt('base', 'http://localhost:8490/');
const URL = `${BASE}?autostart=600&map=${MAP}`;

// ------------------------------------------------------------------------------------------ in-page library
const LIB = `(() => {
  const g = __inkwave, G = __G, a = g.match.local;
  const V = a.pos.constructor;
  g.debug.freeze(); g.debug.freezeBots();
  // park everyone else far from the test lanes
  let k = 0; for (const o of g.match.actors) if (o !== a) { const pad = G.level.spawnPads[o.team]; o.pos.set(pad.x + (k++ % 4) * 1.2 - 1.8, pad.y + 0.02, pad.z); o.vel.set(0, 0, 0); }
  const S = {};
  const KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'KeyE'];
  S.frame = () => { g._skipRender = true; g._frame(1 / 60); g._skipRender = false; };
  S.keys = (list) => { for (const c of KEYS) if (!list.includes(c)) g.debug.key(c, false); for (const c of list) if (!g.input.keys.has(c)) g.debug.key(c, true); };
  S.fire = (on) => { g.input.mouse.left = !!on; };
  S.ground = (x, z, yMax = 50) => G.level.groundHeight(x, z, yMax);
  S.place = (x, y, z, yaw, pitch = -0.12, form) => {
    S.keys([]); S.fire(false);
    if (!a.alive) a.respawn();
    a.superJumpState = null; a.specialActive = null;
    a.pos.set(x, y, z); a.vel.set(0, 0, 0);
    a.yaw = a.aimYaw = yaw; g.rig.yaw = yaw; g.rig.pitch = pitch;
    a.hp = 100; a.ink = 100; a.invuln = 0;
    g.rig.follow(a, true);
    for (let i = 0; i < 40; i++) { a.pos.x = x; a.pos.z = z; a.vel.x = 0; a.vel.z = 0; S.frame(); }
  };
  S.sample = (t) => {
    const c = G.camera, f = c.getWorldDirection(new V());
    const r = a.character.root.position;
    return {
      t, x: a.pos.x, y: a.pos.y, z: a.pos.z, vx: a.vel.x, vy: a.vel.y, vz: a.vel.z,
      gr: a.grounded ? 1 : 0, yaw: a.yaw, form: a.anim.form, ry: r.y, rx: r.x, rz: r.z,
      cx: c.position.x, cy: c.position.y, cz: c.position.z, fx: f.x, fy: f.y, fz: f.z, fov: c.fov,
      gt: a.groundTeam, hp: a.hp, clim: a.climbing ? 1 : 0,
    };
  };
  S.run = (n, rec, each) => { for (let i = 0; i < n; i++) { if (each) each(i); S.frame(); if (rec) rec.push(S.sample(rec.length / 60)); } return rec; };
  S.paintStrip = (x0, z0, x1, z1, y = 0.3, r = 1.3, team = 0) => {
    const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.8);
    for (let i = 0; i <= n; i++) { const t = i / n; G.paint.splat(new V(x0 + (x1 - x0) * t, y, z0 + (z1 - z0) * t), r, team, { seed: i * 0.37 }); }
    G.paint.flush?.(0);
  };
  window.__S = S;
  return 'ok';
})()`;

// ------------------------------------------------------------------------------------------ scenarios (in-page)
const SC = {};
SC.accel = `(() => { const S = __S, out = {};
  S.place(-3, 0.02, -26, 0);
  const r1 = []; S.keys(['KeyW']); S.run(70, r1); out.go = r1;
  const r2 = []; S.keys([]); S.run(45, r2); out.stop = r2;
  S.place(-3, 0.02, -26, 0); S.keys(['KeyW']); S.run(50);
  const r3 = []; S.keys(['KeyS']); S.run(50, r3); out.rev = r3;
  S.keys([]); return out; })()`;
SC.turn = `(() => { const S = __S, out = {};
  S.place(-3, 0.02, -26, 0); S.keys(['KeyW']); S.run(45);
  const r1 = []; S.keys(['KeyD']); S.run(50, r1); out.t90 = r1;
  S.place(0, 0.02, -26, 0); S.keys(['KeyW']); S.run(45);
  const r2 = []; S.keys(['KeyW', 'KeyD']); S.run(40, r2); out.t45 = r2;
  S.place(-3, 0.02, -28, 0); S.keys(['KeyW']); S.run(45);
  const r3 = []; S.keys(['KeyS']); S.run(50, r3); out.t180 = r3;
  // circle strafe: W + mouse turning (camera yaw) — measures facing lag and camera smoothness under a steady mouse turn
  S.place(-3, 0.02, -24, 0); S.keys(['KeyW']); S.run(30);
  const r4 = []; S.run(90, r4, () => { __inkwave.input.mouse.dx += 14; }); out.mouseTurn = r4;
  S.keys([]); return out; })()`;
SC.rampUp = `(() => { const S = __S, out = {};
  S.place(2.2, 0.02, -17, 0); const r = []; S.keys(['KeyW']); S.run(240, r); out.r = r; S.keys([]); return out; })()`;
SC.rampDown = `(() => { const S = __S, out = {};
  S.place(2.2, 2.82, 3, Math.PI); const r = []; S.keys(['KeyW']); S.run(170, r); out.r = r; S.keys([]); return out; })()`;
SC.crossSlope = `(() => { const S = __S, out = {};
  S.place(16.0, S.ground(16.0, -19.25) + 0.02, -19.25, Math.PI); const r = []; S.keys(['KeyD']); S.run(70, r); out.r = r;
  S.place(19.0, S.ground(19.0, -19.25) + 0.02, -19.25, Math.PI); const r2 = []; S.keys(['KeyA']); S.run(70, r2); out.r2 = r2;
  S.keys([]); return out; })()`;
SC.standSlope = `(() => { const S = __S, out = {};
  S.place(2.2, S.ground(2.2, -8.5) + 0.02, -8.5, 0); const r = []; S.run(150, r); out.r = r; return out; })()`;
SC.ledge = `(() => { const S = __S, out = {};
  S.place(0, 2.22, -38, 0); const r = []; S.keys(['KeyW']); S.run(100, r); out.r = r; S.keys([]); return out; })()`;
SC.jump = `(() => { const S = __S, out = {};
  S.place(-3, 0.02, -26, 0); const r = []; S.keys(['Space']); S.run(1, r); S.keys([]); S.run(60, r); out.stand = r;
  S.place(-3, 0.02, -30, 0); S.keys(['KeyW']); S.run(40); const r2 = []; S.keys(['KeyW', 'Space']); S.run(1, r2); S.keys(['KeyW']); S.run(60, r2); out.run = r2;
  S.keys([]); return out; })()`;
SC.buffer = `(() => { const S = __S, out = {};
  // jump buffer: press jump 6 frames (0.1 s) before touching down from a 1.2 m drop
  const res = [];
  for (const early of [2, 4, 6, 8, 10]) {
    S.place(-3, 0.02, -26, 0); __inkwave.match.local.pos.y = 1.6; __inkwave.match.local.vel.y = 0;
    const r = []; let landF = -1;
    for (let i = 0; i < 80; i++) { S.frame(); r.push(S.sample(i / 60)); if (landF < 0 && r[i].gr) landF = i; }
    // replay knowing the landing frame
    S.place(-3, 0.02, -26, 0); __inkwave.match.local.pos.y = 1.6; __inkwave.match.local.vel.y = 0;
    const r2 = []; let jumped = false;
    for (let i = 0; i < 80; i++) {
      if (i === landF - early) S.keys(['Space']); if (i === landF - early + 1) S.keys([]);
      S.frame(); r2.push(S.sample(i / 60));
      if (i > landF && r2[i].vy > 3) jumped = true;
    }
    res.push({ early, landF, jumped });
  }
  out.buffer = res;
  // coyote: walk off the spawn deck edge, press jump N frames after leaving the ground
  const co = [];
  for (const late of [1, 3, 5, 7, 9]) {
    S.place(0, 2.22, -36.2, 0); S.keys(['KeyW']);
    let leftF = -1, jumped = false; const r = [];
    for (let i = 0; i < 70; i++) {
      if (leftF >= 0 && i === leftF + late) S.keys(['KeyW', 'Space']); else if (leftF >= 0 && i === leftF + late + 1) S.keys(['KeyW']);
      S.frame(); const s = S.sample(i / 60); r.push(s);
      if (leftF < 0 && i > 2 && !s.gr && s.y < 2.3 && s.z > -35.5) leftF = i;
      if (leftF >= 0 && i >= leftF + late && s.vy > 3) jumped = true;
    }
    co.push({ late, leftF, jumped });
  }
  out.coyote = co;
  S.keys([]); return out; })()`;
SC.swim = `(() => { const S = __S, out = {};
  S.paintStrip(-3, -33, -3, -14, 0.3, 1.6); S.paintStrip(-3, -21, 3.2, -21, 0.3, 1.6);
  S.place(-3, 0.02, -32, 0); S.keys(['ShiftLeft']); S.run(20);
  const r = []; S.keys(['ShiftLeft', 'KeyW']); S.run(55, r); out.go = r;
  // turn left (A) at swim speed onto the cross strip → turn radius
  S.place(-3, 0.02, -31, 0); S.keys(['ShiftLeft', 'KeyW']); S.run(46);
  const r2 = []; S.keys(['ShiftLeft', 'KeyA']); S.run(40, r2); out.turn = r2;
  // swim off the end of the strip onto dry ground
  S.place(-3, 0.02, -24, 0); S.keys(['ShiftLeft', 'KeyW']); const r3 = []; S.run(70, r3); out.exit = r3;
  // swim jump
  S.place(-3, 0.02, -30, 0); S.keys(['ShiftLeft', 'KeyW']); S.run(40); const r4 = []; S.keys(['ShiftLeft', 'KeyW', 'Space']); S.run(1, r4); S.keys(['ShiftLeft', 'KeyW']); S.run(60, r4); out.jump = r4;
  S.keys([]); return out; })()`;
SC.climb = `(() => { const S = __S, out = {}, V = __G.camera.position.constructor, G = __G;
  // central tower south face (z = -5, top 2.8): ink a column, swim in from the south, climb, pop onto the top
  for (let y = 0.3; y < 2.8; y += 0.5) for (let x = -4.4; x <= -1.6; x += 0.7) G.paint.splat(new V(x, y, -5.25), 0.8, 0, { seed: y + x });
  S.paintStrip(-3, -10, -3, -5.4, 0.3, 1.3);
  S.place(-3, 0.02, -10, 0, 0.05); S.keys(['ShiftLeft']); S.run(15);
  const r = []; S.keys(['ShiftLeft', 'KeyW']);
  for (let i = 0; i < 140; i++) { S.frame(); const s = S.sample(r.length / 60); r.push(s); if (i > 20 && !s.clim && r[r.length - 2].clim) { S.keys(['ShiftLeft']); } }
  S.run(30, r); out.r = r; S.keys([]);
  return out; })()`;
SC.stepLip = `(() => { const S = __S, out = {}, G = __G;
  // list low obstacles (lips) in the level for reference
  out.lips = G.level.blocks.filter((b) => b.solid && b.aabbMax.y - b.aabbMin.y < 0.45 && b.aabbMax.y > 0.02 && b.aabbMax.y < 0.5).map((b) => [b.id, +b.aabbMin.x.toFixed(2), +b.aabbMax.x.toFixed(2), +b.aabbMin.y.toFixed(2), +b.aabbMax.y.toFixed(2), +b.aabbMin.z.toFixed(2), +b.aabbMax.z.toFixed(2), b.hidden ? 1 : 0]).slice(0, 30);
  return out; })()`;
SC.bots = `(() => { const g = __inkwave, G = __G, a = g.match.local, S = __S;
  // un-freeze every bot (freezeBots shadowed the prototype update on each instance), park the local player
  for (const o of g.match.actors) if (o.bot && !o.isLocal) delete o.bot.update;
  const N = 1800, per = new Map();
  const hits = new Map(), kills = new Map();
  const off1 = (G.on || (() => () => {}));
  const bus = window.__inkwaveBus;
  for (const o of g.match.actors) if (o !== a) per.set(o, { yaw: [], aim: [], sp: [], hd: [], fire: 0, idle: 0, n: 0 });
  const origApply = G.projectiles.applyHit.bind(G.projectiles);
  G.projectiles.applyHit = (att, vic, dmg, wid) => { hits.set(att, (hits.get(att) || 0) + 1); const was = vic.alive; origApply(att, vic, dmg, wid); if (was && !vic.alive) kills.set(att, (kills.get(att) || 0) + 1); };
  for (let i = 0; i < N; i++) {
    a.pos.set(G.level.spawnPads[0].x, G.level.spawnPads[0].y, G.level.spawnPads[0].z - 2); a.vel.set(0, 0, 0); a.invuln = 9;
    S.frame();
    for (const [o, r] of per) {
      if (!o.alive || o.superJumpState) { r.yaw.push(null); r.aim.push(null); continue; }
      r.yaw.push(o.yaw); r.aim.push(o.aimYaw);
      const sp = Math.hypot(o.vel.x, o.vel.z); r.sp.push(sp); r.hd.push(sp > 2 ? Math.atan2(o.vel.x, o.vel.z) : null);
      if (o.intent.fire) r.fire++;
      if (sp < 0.3 && !o.weaponRunner.charging && o.grounded) r.idle++;
      r.n++;
    }
  }
  G.projectiles.applyHit = origApply;
  const wrap = (d) => { while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
  const rates = (arr) => { const out = []; for (let i = 1; i < arr.length; i++) if (arr[i] !== null && arr[i - 1] !== null) out.push(wrap(arr[i] - arr[i - 1]) * 60); return out; };
  const accs = (rt) => { const out = []; for (let i = 1; i < rt.length; i++) out.push((rt[i] - rt[i - 1]) * 60); return out; };
  const pct = (arr, q) => { if (!arr.length) return 0; const s = arr.map(Math.abs).sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
  const all = { yawR: [], yawA: [], aimR: [], aimA: [], hdR: [] }; let idle = 0, n = 0, fire = 0, turf = 0;
  for (const [o, r] of per) {
    const yr = rates(r.yaw), ar = rates(r.aim), hr = rates(r.hd);
    all.yawR.push(...yr); all.yawA.push(...accs(yr)); all.aimR.push(...ar); all.aimA.push(...accs(ar)); all.hdR.push(...hr);
    idle += r.idle; n += r.n; fire += r.fire; turf += o.stats.turf;
  }
  const twitch = all.yawA.filter((v) => Math.abs(v) > 400).length;
  let H = 0, K = 0; for (const [, v] of hits) H += v; for (const [, v] of kills) K += v;
  return { frames: N, facingRateP95: +pct(all.yawR, 0.95).toFixed(2), facingRateP99: +pct(all.yawR, 0.99).toFixed(2), facingAccP99: +pct(all.yawA, 0.99).toFixed(1), facingTwitchPerMin: +(twitch / (n / 60) * 60).toFixed(1),
    aimRateP99: +pct(all.aimR, 0.99).toFixed(2), aimAccP99: +pct(all.aimA, 0.99).toFixed(1), headingRateP99: +pct(all.hdR, 0.99).toFixed(2),
    idleFrac: +(idle / n).toFixed(3), fireFrac: +(fire / n).toFixed(3), turf7: Math.round(turf), hits: H, splats: K };
})()`;
SC.lip = `(() => { const S = __S, out = {};
  // 0.12 m pallet collider at x -23.99..-22.61, z -38.81..-37.59 (tidewater): walk over it
  S.place(-23.3, 0.02, -36.9, Math.PI); const r = []; S.keys(['KeyW']); S.run(50, r); out.r = r; S.keys([]); return out; })()`;
SC.grate = `(() => { const S = __S, out = {};
  // kelpline grate bridge x 12..16, z -3..3 over the 2 m trench: kid walks across; squid drops through
  S.place(14, 0.02, -6, 0); const r = []; S.keys(['KeyW']); S.run(110, r); out.kid = r;
  S.place(14, 0.02, -5, 0); S.keys(['ShiftLeft']); S.run(10); const r2 = []; S.keys(['ShiftLeft', 'KeyW']); S.run(60, r2); out.squid = r2;
  S.keys([]); return out; })()`;
SC.cam = `(() => { const S = __S, out = {};
  // camera behaviour: back into a wall (collision pull-in), then walk out; strafe past a pillar
  S.place(-3, 0.02, -8.2, Math.PI, -0.12); const r = []; S.keys(['KeyS']); S.run(40, r); S.keys(['KeyW']); S.run(60, r); out.wall = r;
  // strafe along the tower's south face with the camera looking north (tower between?) and a pillar passing behind
  S.place(-8, 0.02, -8, Math.PI / 2, -0.12); const r2 = []; S.keys(['KeyD']); S.run(120, r2); out.strafe = r2;
  S.keys([]); return out; })()`;
SC.aim = `(async () => { const S = __S, out = {}, G = __G, g = __inkwave, a = g.match.local;
  const cfg = await import('/src/config.js');
  const V = a.pos.constructor;
  const res = [];
  // stand facing the tower's south face (z = -5) from various distances; aim at a point on the wall at y=1.4
  const shoot = (weapon, d, yOff, spread0) => {
    a.setWeapon(weapon);
    S.place(-2.0, 0.02, -5 - d, 0, 0);
    // aim so the crosshair is on (x=-2+lat, y=target, z=-5)
    const target = new V(-2.0, 1.4 + yOff, -5);
    let hitPt = null, fireAim = null;
    const P = G.projectiles;
    const oImpact = P._impact.bind(P);
    P._impact = (p, hit) => { if (!hitPt) hitPt = hit.point.clone(); return oImpact(p, hit); };
    const w = cfg.WEAPONS[weapon]; const sg = w.spreadGround, sa = w.spreadAir, s1 = w.spread; if (spread0) { w.spreadGround = 0; w.spreadAir = 0; w.spread = 0; }
    // solve camera yaw/pitch toward the target iteratively (camera origin depends on pitch)
    for (let it = 0; it < 30; it++) {
      S.frame();
      const c = G.camera.position; const dx = target.x - c.x, dy = target.y - c.y, dz = target.z - c.z;
      g.rig.yaw = Math.atan2(dx, dz); g.rig.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    }
    S.frame();
    fireAim = a.aimPoint.clone();
    const camP = G.camera.position.clone(), camF = G.camera.getWorldDirection(new V());
    if (weapon === 'charger') { S.fire(true); S.run(75); S.fire(false); S.frame(); const b = P.beams[P.beams.length - 1]; if (b) { const dir = new V(0, 0, 1).applyQuaternion(b.mesh.quaternion); hitPt = b.mesh.position.clone().addScaledVector(dir, b.mesh.scale.z); } }
    else { S.fire(true); S.frame(); S.fire(false); S.run(60); }
    P._impact = oImpact; w.spreadGround = sg; w.spreadAir = sa; if (s1 === undefined) delete w.spread; else w.spread = s1;
    if (!hitPt) return { weapon, d, miss: true };
    const e1 = hitPt.clone().sub(camP).normalize();
    const angErr = Math.acos(Math.min(1, e1.dot(camF))) * 180 / Math.PI;
    return { weapon, d, dy: +(hitPt.y - target.y).toFixed(3), dx: +(hitPt.x - target.x).toFixed(3), dist: +hitPt.distanceTo(target).toFixed(3), angErrDeg: +angErr.toFixed(3), aimErr: +fireAim.distanceTo(target).toFixed(3) };
  };
  for (const d of [3, 6, 9, 12]) res.push(shoot('shooter', d, 0, true));
  for (const d of [4, 8, 12]) res.push(shoot('blaster', d, 0, true));
  for (const d of [4, 10, 16]) res.push(shoot('charger', d, 0, true));
  a.setWeapon('shooter');
  out.res = res; return out; })()`;

// ------------------------------------------------------------------------------------------ metrics
const hyp = (x, z) => Math.hypot(x, z);
const r3 = (v) => Math.round(v * 1000) / 1000;
function speedSeries(r) { return r.map((s) => hyp(s.vx, s.vz)); }
function firstIdx(arr, fn) { for (let i = 0; i < arr.length; i++) if (fn(arr[i], i)) return i; return -1; }
function hp(arr, win = 2) { // high-pass residual: value - centered moving average (window 2*win+1)
  const out = [];
  for (let i = win; i < arr.length - win; i++) { let s = 0; for (let k = -win; k <= win; k++) s += arr[i + k]; out.push(arr[i] - s / (2 * win + 1)); }
  return out;
}
function d2(arr) { const o = []; for (let i = 2; i < arr.length; i++) o.push(arr[i] - 2 * arr[i - 1] + arr[i - 2]); return o; }
const rms = (a) => (a.length ? Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length) : 0);
const maxAbs = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
function unwrap(a) { const o = [a[0]]; for (let i = 1; i < a.length; i++) { let d = a[i] - a[i - 1]; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; o.push(o[i - 1] + d); } return o; }
// oscillation count: sign flips of the frame-to-frame velocity where both neighbours move > thr (a bounce, not a kink)
function reversals(arr, thr = 0.0015) {
  let n = 0, last = 0;
  for (let i = 1; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    if (Math.abs(d) < thr) continue;
    const s = Math.sign(d);
    if (last && s !== last) n++;
    last = s;
  }
  return n;
}
function jitter(r, label) {
  const y = r.map((s) => s.y), ry = r.map((s) => s.ry), cy = r.map((s) => s.cy);
  const camYaw = unwrap(r.map((s) => Math.atan2(s.fx, s.fz))), camPitch = r.map((s) => Math.asin(Math.max(-1, Math.min(1, s.fy))));
  const D = 180 / Math.PI;
  let toggles = 0; for (let i = 1; i < r.length; i++) if (r[i].gr !== r[i - 1].gr) toggles++;
  const sp = speedSeries(r);
  return {
    label,
    yD2rmsMM: r3(rms(d2(y)) * 1000), yD2maxMM: r3(maxAbs(d2(y)) * 1000), yHPrmsMM: r3(rms(hp(y)) * 1000), yHPmaxMM: r3(maxAbs(hp(y)) * 1000),
    rootHPmaxMM: r3(maxAbs(hp(ry)) * 1000),
    camYHPmaxMM: r3(maxAbs(hp(cy)) * 1000), camYD2maxMM: r3(maxAbs(d2(cy)) * 1000),
    camYawHPmaxDeg: r3(maxAbs(hp(camYaw)) * D), camPitchHPmaxDeg: r3(maxAbs(hp(camPitch)) * D), camPitchD2maxDeg: r3(maxAbs(d2(camPitch)) * D),
    groundToggles: toggles, airFrames: r.filter((s) => !s.gr).length,
    yReversals: reversals(y), rootReversals: reversals(ry), camYReversals: reversals(cy, 0.001),
    camRelStepMaxMM: r3(Math.max(0, ...r.slice(1).map((s, i) => Math.hypot((s.cx - s.x) - (r[i].cx - r[i].x), (s.cy - s.y) - (r[i].cy - r[i].y), (s.cz - s.z) - (r[i].cz - r[i].z)))) * 1000),
    camDistReversals: reversals(r.map((s) => Math.hypot(s.cx - s.x, s.cy - s.y - 1.8, s.cz - s.z)), 0.004),
    speedMin: r3(Math.min(...sp.slice(10))), speedMax: r3(Math.max(...sp)),
  };
}
function accelMetrics(o) {
  const top = 6.0;
  const sp = speedSeries(o.go);
  const t90 = firstIdx(sp, (v) => v >= 0.9 * top), t99 = firstIdx(sp, (v) => v >= 0.99 * top);
  const ss = speedSeries(o.stop);
  const tStop = firstIdx(ss, (v) => v < 0.05);
  const z0 = o.go[o.go.length - 1].z;
  const stopDist = o.stop[o.stop.length - 1].z - z0;
  const rv = o.rev.map((s) => s.vz);
  const tRev0 = firstIdx(rv, (v) => v <= 0), tRev90 = firstIdx(rv, (v) => v <= -0.9 * top);
  // jerk: max change of acceleration (m/s^3) at start
  const acc = []; for (let i = 1; i < sp.length; i++) acc.push((sp[i] - sp[i - 1]) * 60);
  return {
    t90: t90 / 60, t99: t99 / 60, tStop: tStop / 60, stopDist: r3(stopDist), tReverseZero: tRev0 / 60, tReverse90: tRev90 / 60,
    speedFirst6: sp.slice(0, 8).map(r3), stopFirst8: ss.slice(0, 10).map(r3), accPeak: r3(Math.max(...acc)),
  };
}
function turnMetrics(r, targetAng, label) {
  const ang = (s) => Math.atan2(s.vx, s.vz);
  const diff = (x, y) => { let d = y - x; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
  const velOk = firstIdx(r, (s) => hyp(s.vx, s.vz) > 1 && Math.abs(diff(ang(s), targetAng)) < 10 * Math.PI / 180);
  const faceOk = firstIdx(r, (s) => Math.abs(diff(s.yaw, targetAng)) < 10 * Math.PI / 180);
  const sp = speedSeries(r);
  const yawRate = []; for (let i = 1; i < r.length; i++) yawRate.push(diff(r[i - 1].yaw, r[i].yaw) * 60);
  const yawAcc = []; for (let i = 1; i < yawRate.length; i++) yawAcc.push((yawRate[i] - yawRate[i - 1]) * 60);
  return { label, tVel: velOk / 60, tFace: faceOk / 60, speedMin: r3(Math.min(...sp)), yawRateMax: r3(maxAbs(yawRate)), yawAccMax: r3(maxAbs(yawAcc)), yawRateFirst8: yawRate.slice(0, 8).map((v) => +v.toFixed(1)) };
}
function arc(r, label) {
  const y0 = r[0].y; let apex = -1e9, apexI = 0;
  r.forEach((s, i) => { if (s.y > apex) { apex = s.y; apexI = i; } });
  const land = firstIdx(r, (s, i) => i > 3 && s.gr);
  return { label, apexH: r3(apex - y0), tApex: r3(apexI / 60), tAir: land > 0 ? r3(land / 60) : null, dist: land > 0 ? r3(hyp(r[land].x - r[0].x, r[land].z - r[0].z)) : null, landVy: land > 0 ? r3(r[land - 1].vy) : null };
}

// ------------------------------------------------------------------------------------------ run
const browser = await puppeteer.launch({
  executablePath: chromePath(), headless: 'new',
  args: gpuArgs(['--window-size=1280,720']),
  defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => { const t = m.type(); if (t === 'error' || t === 'warning' || t === 'warn') logs.push(`[${t}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction("window.__inkwave && __inkwave.match && __inkwave.match.state==='playing' && __inkwave.match.local", { timeout: 90000, polling: 100 });
await page.evaluate(LIB);
const want = ONLY ? ONLY.split(',') : Object.keys(SC).filter((k) => k !== 'bots' && (MAP === 'tidewater' ? k !== 'grate' : ['swim', 'stepLip', 'grate'].includes(k)));
const raw = {}, report = {};
for (const name of want) {
  if (!SC[name]) { console.log('unknown scenario', name); continue; }
  let o;
  try { o = await page.evaluate(SC[name]); } catch (e) { console.log(name, 'ERROR', e.message); continue; }
  raw[name] = o;
  if (name === 'accel') report.accel = accelMetrics(o);
  if (name === 'turn') report.turn = [turnMetrics(o.t90, -Math.PI / 2, 'W→D (90°)'), turnMetrics(o.t45, -Math.PI / 4, 'W→W+D (45°)'), turnMetrics(o.t180, Math.PI, 'W→S (180°)'), jitter(o.mouseTurn, 'mouse circle-run')];
  if (name === 'turn') { const r = o.mouseTurn; const lag = r.map((s) => { let d = Math.atan2(s.fx, s.fz) - s.yaw; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }); report.turn.push({ label: 'mouse turn facing lag (deg, last 30f avg)', lag: r3(lag.slice(-30).reduce((s, v) => s + v, 0) / 30 * 180 / Math.PI) }); }
  if (name === 'rampUp' || name === 'rampDown' || name === 'standSlope' || name === 'ledge') report[name] = jitter(o.r, name);
  if (name === 'standSlope') report.standSlope.driftM = r3(hyp(o.r[o.r.length - 1].x - o.r[0].x, o.r[o.r.length - 1].z - o.r[0].z));
  if (name === 'crossSlope') report.crossSlope = [jitter(o.r, 'across ramp (off the side)'), jitter(o.r2, 'across ramp (reverse)')];
  if (name === 'jump') report.jump = [arc(o.stand, 'standing jump'), arc(o.run, 'running jump')];
  if (name === 'buffer') report.buffer = o;
  if (name === 'swim') {
    const sp = speedSeries(o.go); report.swim = { t90: firstIdx(sp, (v) => v > 0.9 * 11.8) / 60, top: r3(Math.max(...sp)), first8: sp.slice(0, 8).map(r3) };
    report.swim.turn = turnMetrics(o.turn, Math.PI / 2, 'swim W→A');
    const pts = o.turn.map((s) => [s.x, s.z]); report.swim.turn.overshootM = r3(Math.max(...pts.map((p) => p[1])) - pts[0][1]);
    report.swim.exit = jitter(o.exit, 'swim off ink edge'); report.swim.exitSpeeds = speedSeries(o.exit).filter((_, i) => i % 5 === 0).map(r3);
    report.swim.jump = arc(o.jump, 'swim jump');
  }
  if (name === 'climb') {
    const r = o.r; const c0 = firstIdx(r, (s) => s.clim); const c1 = firstIdx(r, (s, i) => i > c0 && c0 >= 0 && !s.clim);
    report.climb = { climbStart: c0 / 60, climbEnd: c1 / 60, maxY: r3(Math.max(...r.map((s) => s.y))), endY: r3(r[r.length - 1].y), endX: r3(r[r.length - 1].x), vyAtExit: c1 > 0 ? r3(r[c1].vy) : null, forms: [...new Set(r.map((s) => s.form))].join(','), ...jitter(r.slice(Math.max(0, c0 - 5)), 'climb') };
  }
  if (name === 'stepLip') report.lips = o.lips;
  if (name === 'cam') report.cam = [jitter(o.wall, 'back into wall + out'), jitter(o.strafe, 'strafe past tower')];
  if (name === 'cam') { const d = o.wall.map((s) => hyp(s.cx - s.x, s.cz - s.z)); report.cam.push({ label: 'wall: cam-player horiz dist', series: d.filter((_, i) => i % 4 === 0).map((v) => +v.toFixed(2)) }); }
  if (name === 'aim') report.aim = o.res;
  if (name === 'bots') report.bots = o;
  if (name === 'lip') { const r = o.r; const top = Math.max(...r.map((s) => s.y)); const steps = r.slice(1).map((s, i) => s.ry - r[i].ry); report.lip = { ...jitter(r, 'walk over 0.12 m lip'), liftedTo: r3(top), rootMaxStepMM: r3(Math.max(...steps.map(Math.abs)) * 1000), feetMaxStepMM: r3(Math.max(...r.slice(1).map((s, i) => Math.abs(s.y - r[i].y))) * 1000) }; }
  if (name === 'grate') { report.grate = [jitter(o.kid, 'kid across grate bridge'), { label: 'kid min y on grate', minY: r3(Math.min(...o.kid.map((s) => s.y))) }, { label: 'squid through grate: min y', minY: r3(Math.min(...o.squid.map((s) => s.y))) }]; }
}
console.log(JSON.stringify(report, null, 1));
if (logs.length) console.log(logs.slice(0, 20).join('\n'));
if (RAW) { mkdirSync(RAW.replace(/\/[^/]*$/, ''), { recursive: true }); writeFileSync(RAW, JSON.stringify(raw)); console.log('raw ->', RAW); }
await browser.close();
