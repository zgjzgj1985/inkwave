// Objective audio audit for src/audio/*.js — renders every SFX and every music track through OfflineAudioContext in
// the real Chrome (same engine code, same master chain) and measures them.
//
// usage: node tools/audio-test.mjs [--url http://localhost:8490/tools/audio-lab.html] [--only name,name] [--bars 16]
//                                  [--wav outDir]  (writes a .wav per render so a human can listen)
//                                  [--json out.json]
// Per render: duration (to -60 dBFS), peak / raw peak (dBFS, raw = without master dynamics), RMS (dBFS, active part),
// LUFS-M max (BS.1770 K-weighted, 400 ms), integrated LUFS (music), DC offset, NaN count, clipped samples (>0.99),
// clicks (sample-step outliers vs local activity), start/tail level, spectral balance (low <250, lmid <2k, hmid <6k, high).
import puppeteer from 'puppeteer-core';
import { chromePath, gpuArgs } from './chrome.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const URL_ = opt('url', 'http://localhost:8490/tools/audio-lab.html');
const ONLY = opt('only', '');
const BARS = +opt('bars', 16);
const WAV = opt('wav', '');
const JSON_OUT = opt('json', '');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- contract names straight from docs/CONTRACTS.md ----
const contracts = fs.readFileSync(path.join(ROOT, 'docs/CONTRACTS.md'), 'utf8');
const sec = contracts.slice(contracts.indexOf('SFX names (all must exist)'), contracts.indexOf('Music: original'));
const CONTRACT_NAMES = [...sec.matchAll(/`([^`]+)`/g)].flatMap((m) => m[1].replace(/\([^)]*\)/g, ' ').split(/\s+/)).filter(Boolean);

const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: 'new',
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
  protocolTimeout: 1800000,
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => { const t = m.type(); if (t === 'error' || t === 'warning' || t === 'warn') logs.push(`[${t}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(URL_, { waitUntil: 'load', timeout: 60000 });

page.setDefaultTimeout(600000);
await page.evaluate(async (cfg) => {
  const A = await import('/src/audio/audio.js');
  const M = await import('/src/audio/music.js');
  const SR = 48000;
  const out = { sfx: [], music: [], api: [], names: A.SFX_NAMES, wavs: {} };

  // ---------------- analysis ----------------
  const K1 = { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [-1.69065929318241, 0.73248077421585] };
  const K2 = { b: [1, -2, 1], a: [-1.99004745483398, 0.99007225036621] };
  function biq(x, c) {
    const y = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = c.b[0] * x[i] + c.b[1] * x1 + c.b[2] * x2 - c.a[0] * y1 - c.a[1] * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ar = re[i + k], ai = im[i + k], br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ar + br; im[i + k] = ai + bi; re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }
  const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
  function analyze(buf, { integrated = false } = {}) {
    const n = buf.length, L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    let peak = 0, nan = 0, clip = 0, sum = 0, first = -1, last = -1;
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      if (!Number.isFinite(l) || !Number.isFinite(r)) { nan++; continue; }
      const a = Math.max(Math.abs(l), Math.abs(r));
      if (a > peak) peak = a;
      if (a > 0.99) clip++;
      sum += (l + r) * 0.5;
      if (a > 0.001) { if (first < 0) first = i; last = i; }
    }
    let ss = 0;
    const a0 = Math.max(0, first), a1 = Math.max(a0 + 1, last + 1);
    for (let i = a0; i < a1; i++) ss += (L[i] * L[i] + R[i] * R[i]) * 0.5;
    const rms = Math.sqrt(ss / (a1 - a0));
    // loudness (BS.1770)
    const kl = biq(biq(L, K1), K2), kr = R === L ? kl : biq(biq(R, K1), K2);
    const B = Math.floor(0.4 * SR), H = Math.floor(0.1 * SR);
    const blocks = [];
    for (let s = 0; s + B <= n; s += H) {
      let zl = 0, zr = 0;
      for (let i = s; i < s + B; i++) { zl += kl[i] * kl[i]; zr += kr[i] * kr[i]; }
      blocks.push(zl / B + zr / B);
    }
    if (!blocks.length) blocks.push(0);
    const lk = (z) => (z > 0 ? -0.691 + 10 * Math.log10(z) : -Infinity);
    const mMax = lk(Math.max(...blocks));
    let integ = null;
    if (integrated) {
      const g1 = blocks.filter((z) => lk(z) > -70);
      const m1 = g1.reduce((a, b) => a + b, 0) / (g1.length || 1);
      const g2 = g1.filter((z) => lk(z) > lk(m1) - 10);
      integ = lk(g2.reduce((a, b) => a + b, 0) / (g2.length || 1));
    }
    // clicks: first-difference outliers vs local difference energy
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) mono[i] = (L[i] + R[i]) * 0.5;
    const pre = new Float64Array(n + 1);
    for (let i = 1; i < n; i++) { const d = mono[i] - mono[i - 1]; pre[i + 1] = pre[i] + d * d; }
    const W = 512;
    let clicks = 0, worst = 0, clickAt = [];
    for (let i = 1; i < n; i++) {
      const d = Math.abs(mono[i] - mono[i - 1]);
      if (d < 0.03) continue;
      const lo = Math.max(1, i - W), hi = Math.min(n - 1, i + W);
      const loc = Math.sqrt((pre[hi + 1] - pre[lo]) / (hi - lo + 1));
      const ratio = d / (loc || 1e-9);
      if (ratio > worst && d > 3 * Math.max(Math.abs(mono[i - 1] - mono[i - 2] || 0), Math.abs((mono[i + 1] ?? 0) - mono[i]))) worst = ratio;
      // a real discontinuity is an isolated single-sample step (≫ both adjacent steps); steep band-limited edges spread
      const iso = d > 3 * Math.max(Math.abs(mono[i - 1] - mono[i - 2] || 0), Math.abs((mono[i + 1] ?? 0) - mono[i]));
      if (ratio > 16 && iso) { clicks++; if (clickAt.length < 5) clickAt.push(+(i / SR).toFixed(4)); i += W; }
    }
    // spectral balance over the active region
    const N = 4096, bands = [0, 0, 0, 0];
    const re = new Float64Array(N), im = new Float64Array(N);
    const hop = Math.max(N, Math.floor((a1 - a0) / 200));
    for (let s = a0; s + N <= a1 || s === a0; s += hop) {
      for (let i = 0; i < N; i++) { const x = s + i < n ? mono[s + i] : 0; re[i] = x * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1))); im[i] = 0; }
      fft(re, im);
      for (let k = 1; k < N / 2; k++) {
        const f = (k * SR) / N, pw = re[k] * re[k] + im[k] * im[k];
        bands[f < 250 ? 0 : f < 2000 ? 1 : f < 6000 ? 2 : 3] += pw;
      }
      if (s + N > a1) break;
    }
    const bt = bands.reduce((a, b) => a + b, 0) || 1;
    // tail + start
    const tl = Math.floor(0.02 * SR);
    let ts = 0;
    for (let i = n - tl; i < n; i++) ts += (L[i] * L[i] + R[i] * R[i]) * 0.5;
    return {
      dur: last > 0 ? +(last / SR).toFixed(3) : 0,
      peak: +db(peak).toFixed(1), rms: +db(rms).toFixed(1), lufsM: +mMax.toFixed(1), lufsI: integ == null ? null : +integ.toFixed(1),
      dc: +(sum / n).toExponential(1), nan, clip, clicks, clickRatio: +worst.toFixed(1), clickAt,
      start: +Math.abs(mono[0]).toExponential(1), tail: +db(Math.sqrt(ts / tl)).toFixed(1),
      bands: bands.map((b) => Math.round((100 * b) / bt)), silent: peak < 0.01,
    };
  }
  function wav(buf) {
    const n = buf.length, ch = buf.numberOfChannels, dv = new DataView(new ArrayBuffer(44 + n * ch * 2));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); dv.setUint16(22, ch, true); dv.setUint32(24, SR, true); dv.setUint32(28, SR * ch * 2, true);
    dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * ch * 2, true);
    const cs = [...Array(ch)].map((_, c) => buf.getChannelData(c));
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { dv.setInt16(o, Math.max(-1, Math.min(1, cs[c][i])) * 32767, true); o += 2; }
    let s = '';
    const u8 = new Uint8Array(dv.buffer);
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // ---------------- SFX ----------------
  const only = cfg.only ? cfg.only.split(',') : null;
  async function renderSfx(name, mode, raw) {
    const d = A.SFX[name];
    const isLoop = mode === 'loop';
    const secs = isLoop ? 3.5 : 5.3;
    const ctx = new OfflineAudioContext(2, Math.floor(SR * secs), SR);
    const eng = new A.AudioEngine({ context: ctx, seed: 1234, music: false, raw });
    eng.init();
    eng.setVolumes({ master: 1, music: 1, sfx: 1 });
    eng.master.gain.value = 1; eng.sfxBus.gain.value = 1; eng.musicBus.gain.value = 1;
    if (isLoop) {
      let h;
      ctx.suspend(0.3).then(() => { h = eng.loop(name, { volume: 1, pitch: 1 }); ctx.resume(); });
      ctx.suspend(1.3).then(() => { h.set({ pitch: 1.5, volume: 0.7 }); ctx.resume(); });
      ctx.suspend(2.5).then(() => { h.stop(0.2); ctx.resume(); });
    } else eng.play(name, { at: 0.3 });
    const buf = await ctx.startRendering();
    return { buf, d };
  }
  window.__AT = { out, A, M };
  // detector self-test: a hard gain cut on a sine must register as a click, a 5 ms fade must not
  window.__AT.selftest = () => {
    const mk = (fade) => {
      const b = new AudioBuffer({ length: SR, numberOfChannels: 2, sampleRate: SR });
      for (let c = 0; c < 2; c++) {
        const d = b.getChannelData(c);
        for (let i = 0; i < SR; i++) {
          const t = i / SR, g = t < 0.5 ? 1 : fade ? Math.max(0, 1 - (t - 0.5) / 0.005) : 0;
          d[i] = 0.3 * Math.sin(2 * Math.PI * 200 * t + 0.7) * g;
        }
      }
      return analyze(b).clicks;
    };
    return { hardCut: mk(false), fade5ms: mk(true) };
  };
  window.__AT.sfx = async (name) => {
    const d = A.SFX[name], res = [];
    const modes = d.build && d.loop ? ['shot', 'loop'] : d.loop ? ['loop'] : ['shot'];
    for (const mode of modes) {
      const { buf } = await renderSfx(name, mode, false);
      const r = analyze(buf);
      const raw = analyze((await renderSfx(name, mode, true)).buf);
      res.push({ name, mode, ...r, rawPeak: raw.peak, rawLufsM: raw.lufsM });
      if (cfg.wav) out.wavs[`sfx_${name}${mode === 'loop' && d.build ? '_loop' : ''}.wav`] = wav(buf);
    }
    return res;
  };
  // ---------------- Music ----------------
  async function renderMusic(label, secs, drive) {
    const ctx = new OfflineAudioContext(2, Math.floor(SR * secs), SR);
    const eng = new A.AudioEngine({ context: ctx, seed: 99, music: false });
    eng.init();
    eng.setVolumes({ master: 1, music: 1, sfx: 1 });
    eng.master.gain.value = 1; eng.sfxBus.gain.value = 1; eng.musicBus.gain.value = 1;
    const m = new M.MusicEngine();
    m._init(ctx, eng.musicBus, { offline: true });
    for (let t = 0; t <= secs; t += 0.05) { drive(m, t); m.advance(t); }
    const buf = await ctx.startRendering();
    if (cfg.wav) out.wavs[`music_${label}.wav`] = wav(buf);
    return buf;
  }
  window.__AT.music = async (id) => {
    const res = [];
    const s = M.getSong(id);
    const bar = (60 / s.bpm) * 4;
    const secs = cfg.bars * bar + 1.5;
    let buf = await renderMusic(id, secs, (m, t) => { if (t === 0) m.play(id, { fade: 0, seed: 7 }); });
    res.push({ name: id, mode: `${cfg.bars} bars`, bpm: s.bpm, warnings: s.warnings, ...analyze(buf, { integrated: true }) });
    // loop seam: start 2 bars before the loop wraps, render 4 bars
    buf = await renderMusic(id + '_seam', 4 * bar + 1, (m, t) => { if (t === 0) m.play(id, { fade: 0, startBar: s.bars.length - 2, seed: 7 }); });
    res.push({ name: id, mode: 'loop seam', ...analyze(buf, { integrated: true }) });
    // low intensity layer check
    buf = await renderMusic(id + '_low', 4 * bar + 1, (m, t) => { if (t === 0) { m.setIntensity(0.25); m.play(id, { fade: 0, startBar: s.loopFrom, seed: 7 }); } });
    res.push({ name: id, mode: 'intensity 0.25', ...analyze(buf, { integrated: true }) });
    return res;
  };
  window.__AT.transitions = async () => {
    const res = [];
    // battle → battle_final escalation (beat-synced) and menu → battle crossfade
    let buf = await renderMusic('battle_to_final', 14, (m, t) => {
      if (t === 0) m.play('battle', { fade: 0, startBar: 3, seed: 7 });
      if (Math.abs(t - 4.0) < 1e-6) m.play('battle_final', { fade: 1 });
    });
    res.push({ name: 'battle→battle_final', mode: 'transition', ...analyze(buf, { integrated: true }) });
    buf = await renderMusic('menu_to_battle', 10, (m, t) => {
      if (t === 0) m.play('menu', { fade: 0, seed: 7 });
      if (Math.abs(t - 4.0) < 1e-6) m.play('battle', { fade: 1 });
      if (Math.abs(t - 8.0) < 1e-6) m.stop(1.2);
    });
    res.push({ name: 'menu→battle→stop', mode: 'transition', ...analyze(buf, { integrated: true }) });
    return res;
  };

  // ---------------- API robustness (real AudioContext) ----------------
  window.__AT.api = async () => {
  const api = (name, fn) => { try { const r = fn(); out.api.push({ name, ok: true, r: r === undefined ? '' : String(r) }); } catch (e) { out.api.push({ name, ok: false, r: e.message }); } };
  const E = A.audio;
  api('play before init → no-op', () => E.play('shoot_shooter'));
  api('loop before init → noop handle', () => { const h = E.loop('swim'); h.set({ volume: 1 }); h.stop(); return h.playing; });
  api('setListener/duck/setVolumes before init', () => { E.setListener(); E.duck(); E.setVolumes({ music: 0.5 }); });
  api('music.play before init (deferred)', () => A.music.play('menu'));
  api('init idempotent', () => { E.init(); const c = E.ctx; E.init(); return c === E.ctx && !!c; });
  api('music attached + deferred track started', () => A.music.track);
  api('ctx state', () => E.ctx.state);
  api('play pos undefined', () => !!E.play('splat_small', { pos: undefined }));
  api('play pos NaN', () => !!E.play('splat_small', { pos: { x: NaN, y: 0, z: 0 } }));
  api('play pos 3D', () => { E.setListener({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 }); return !!E.play('bomb_explode', { pos: { x: 8, y: 0, z: -3 } }); });
  api('play unknown name → null + warn once', () => E.play('nope_sound'));
  api('play null opts', () => !!E.play('ui_click', null));
  api('loop set garbage / double stop', () => { const h = E.loop('roll', { pos: { x: 1, y: 0, z: 1 } }); h.set(); h.set({ pitch: NaN, volume: 'x', pos: { x: 2, y: 0, z: 2 } }); h.stop(); h.stop(); return h.playing; });
  api('setListener partial', () => E.setListener({ x: 1, y: 1, z: 1 }));
  api('music unknown track', () => A.music.play('nope'));
  api('music intensity', () => { A.music.setIntensity(0.3); A.music.setIntensity(2); return A.music.intensity; });
  // stress: 30 sounds/s for 2 s, then everything must have been cleaned up
  const pool = ['shoot_shooter', 'splat_small', 'ink_hit_wall', 'hit_marker', 'shoot_blaster', 'splat_big', 'land', 'squid_in'];
  let k = 0;
  await new Promise((res) => {
    const id = setInterval(() => {
      for (let j = 0; j < 3; j++) E.play(pool[(k + j) % pool.length], { pos: { x: Math.sin(k) * 10, y: 0, z: Math.cos(k) * 10 } });
      if (++k >= 20) { clearInterval(id); res(); }
    }, 100);
  });
  out.api.push({ name: 'stress 60 sounds/2s peak stats', ok: true, r: JSON.stringify(E.stats()) });
  A.music.play('battle', { fade: 0.3 });
  await new Promise((r) => setTimeout(r, 1200));
  A.music.play('battle_final', { fade: 1 });
  await new Promise((r) => setTimeout(r, 2500));
  out.api.push({ name: 'music realtime players (battle→final)', ok: A.music.track === 'battle_final', r: `${A.music.track}, players=${A.music.players.length}` });
  A.music.stop(0.5);
  await new Promise((r) => setTimeout(r, 3500));
  const st = E.stats();
  out.api.push({ name: 'voices cleaned up after 3.5 s (disposed via onended)', ok: st.voices === 0, r: JSON.stringify(st) });
  return out.api;
  };
}, { only: ONLY, bars: BARS, wav: !!WAV });


const result = { sfx: [], music: [], api: [], names: [], wavs: {} };
result.names = await page.evaluate(() => window.__AT.A.SFX_NAMES);
const only = ONLY ? ONLY.split(',') : null;
const t0 = Date.now();
for (const n of result.names) {
  if (only && !only.includes(n)) continue;
  result.sfx.push(...(await page.evaluate((n) => window.__AT.sfx(n), n)));
  process.stderr.write(`\r  sfx ${result.sfx.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)   `);
}
const selftest = await page.evaluate(() => window.__AT.selftest());
const trackIds = await page.evaluate(() => Object.keys(window.__AT.M.SONGS));
for (const id of trackIds) {
  if (only && !only.includes(id) && !only.includes('music')) continue;
  result.music.push(...(await page.evaluate((id) => window.__AT.music(id), id)));
  process.stderr.write(`\r  music ${id} (${((Date.now() - t0) / 1000).toFixed(0)}s)          `);
}
if (!only || only.includes('music') || only.includes('battle')) result.music.push(...(await page.evaluate(() => window.__AT.transitions())));
if (!only || only.includes('api')) result.api = await page.evaluate(() => window.__AT.api());
if (WAV) Object.assign(result.wavs, await page.evaluate(() => window.__AT.out.wavs));
process.stderr.write('\n');

await browser.close();

// ---------------- report ----------------
const CLASS = {
  ui: ['ui_hover', 'ui_click', 'ui_back', 'ui_confirm', 'ui_toggle', 'ui_slider', 'ui_error', 'xp_tick', 'empty_click'],
  big: ['bomb_explode', 'special_slam', 'blaster_boom', 'splatted_self', 'storm_thunder', 'roller_flick'],
};
const cls = (n) => (CLASS.ui.includes(n) ? 'ui' : CLASS.big.includes(n) ? 'big' : 'core');
const RANGE = { ui: [-36, -22], core: [-26, -11], big: [-18, -7], loop: [-32, -16] };
const problems = [];
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
console.log(`\nSFX (${result.sfx.length} renders, bus volumes 1.0, full master chain; raw = without master dynamics)`);
console.log(pad('name', 22) + pad('mode', 6) + lpad('dur', 6) + lpad('peak', 7) + lpad('raw', 7) + lpad('rms', 7) + lpad('LUFSm', 7) + lpad('rawLm', 7) + lpad('clk', 5) + lpad('tail', 7) + '  bands L/LM/HM/H %   class');
for (const r of result.sfx) {
  const c = r.mode === 'loop' ? 'loop' : cls(r.name);
  const [lo, hi] = RANGE[c];
  const flags = [];
  if (r.silent) flags.push('SILENT');
  if (r.nan) flags.push('NaN');
  if (r.clip) flags.push('CLIP');
  if (r.rawPeak > -0.1) flags.push('RAWCLIP');
  if (Math.abs(+r.dc) > 0.002) flags.push('DC ' + r.dc);
  if (r.clicks) flags.push('CLICK@' + r.clickAt.join(','));
  if (r.tail != null && r.tail > -70) flags.push('TAIL');
  if (r.lufsM < lo || r.lufsM > hi) flags.push(`LEVEL(${lo}..${hi})`);
  if (flags.length) problems.push(`${r.name}/${r.mode}: ${flags.join(' ')}`);
  console.log(pad(r.name, 22) + pad(r.mode, 6) + lpad(r.dur, 6) + lpad(r.peak, 7) + lpad(r.rawPeak, 7) + lpad(r.rms, 7) + lpad(r.lufsM, 7) + lpad(r.rawLufsM, 7) + lpad(r.clicks, 5) + lpad(r.tail ?? '-inf', 7) + '  ' + pad(r.bands.join('/'), 18) + pad(c, 5) + (flags.length ? ' ⚠ ' + flags.join(' ') : ''));
}
console.log(`\nMusic (bus volumes 1.0, full chain)`);
console.log(pad('track', 24) + pad('mode', 16) + lpad('peak', 7) + lpad('LUFSi', 7) + lpad('LUFSm', 7) + lpad('clk', 5) + lpad('worst', 7) + '  bands L/LM/HM/H %');
for (const r of result.music) {
  const flags = [];
  if (r.silent) flags.push('SILENT');
  if (r.nan) flags.push('NaN');
  if (r.clip) flags.push('CLIP');
  if (r.clicks) flags.push('CLICK@' + r.clickAt.join(','));
  if (Math.abs(+r.dc) > 0.002) flags.push('DC');
  if (r.warnings && r.warnings.length) flags.push('COMPILE:' + r.warnings.join('|'));
  if (r.mode.endsWith('bars') && (r.lufsI < -17 || r.lufsI > -11)) flags.push('LOUDNESS(-17..-11)');
  if (flags.length) problems.push(`music ${r.name}/${r.mode}: ${flags.join(' ')}`);
  console.log(pad(r.name, 24) + pad(r.mode, 16) + lpad(r.peak, 7) + lpad(r.lufsI, 7) + lpad(r.lufsM, 7) + lpad(r.clicks, 5) + lpad(r.clickRatio, 7) + '  ' + r.bands.join('/') + (flags.length ? '  ⚠ ' + flags.join(' ') : ''));
}
console.log(`\nClick-detector self-test: hard cut → ${selftest.hardCut} click(s) (expect ≥1), 5 ms fade → ${selftest.fade5ms} (expect 0)`);
if (!(selftest.hardCut >= 1 && selftest.fade5ms === 0)) problems.push('click detector self-test failed');
console.log('\nAPI robustness (real AudioContext)');
for (const a of result.api) {
  console.log(`  ${a.ok ? 'ok ' : 'ERR'} ${a.name}${a.r !== '' ? ' → ' + a.r : ''}`);
  if (!a.ok) problems.push('api: ' + a.name + ' ' + a.r);
}
const missing = CONTRACT_NAMES.filter((n) => !result.names.includes(n));
console.log(`\nContract names: ${CONTRACT_NAMES.length} in CONTRACTS.md, ${result.names.length} implemented, missing: ${missing.length ? missing.join(' ') : 'none'}`);
if (missing.length) problems.push('missing contract sfx: ' + missing.join(' '));
const pageErrs = logs.filter((l) => !l.includes('unknown sound') && !l.includes('unknown track'));
if (pageErrs.length) { console.log('\nPage console:'); console.log(pageErrs.slice(0, 30).join('\n')); problems.push(...pageErrs.map((l) => 'console: ' + l)); }
console.log(`\n${problems.length ? problems.length + ' PROBLEM(S):\n  ' + problems.join('\n  ') : 'ALL CLEAN'}`);
if (WAV) {
  fs.mkdirSync(WAV, { recursive: true });
  for (const [f, b64] of Object.entries(result.wavs)) fs.writeFileSync(path.join(WAV, f), Buffer.from(b64, 'base64'));
  console.log(`wrote ${Object.keys(result.wavs).length} wav files to ${WAV}`);
}
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ ...result, wavs: undefined, problems }, null, 1));
process.exitCode = problems.length ? 1 : 0;
