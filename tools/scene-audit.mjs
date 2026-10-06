// Drawn-cost audit: freeze the sim, then walk the scene graph counting only what is actually visible.
import puppeteer from 'puppeteer-core';
import { chromePath, gpuArgs } from './chrome.mjs';
const sleep = (t) => new Promise((r) => setTimeout(r, t));
const b = await puppeteer.launch({ executablePath: chromePath(), headless: 'new',
  args: gpuArgs(['--window-size=915,412']), defaultViewport: { width: 915, height: 412, deviceScaleFactor: 2, isMobile: true, hasTouch: true } });
const p = await b.newPage();
await p.goto('http://localhost:8492/?autostart=600&autopilot&quality=low&nofullscreen', { waitUntil: 'domcontentloaded', timeout: 60000 });
for (let i = 0; i < 90; i++) { await sleep(2000); if (await p.evaluate(() => window.__inkwave?.match?.state === 'playing').catch(() => false)) break; }
await sleep(8000);
const rows = await p.evaluate(() => {
  const g = window.__inkwave, G = window.__G;
  g.debug.freeze();
  const scene = (g.R && g.R.scene) || G.scene;
  if (!scene) return { err: 'no scene handle' };
  // count only meshes that would actually be submitted: the whole ancestor chain must be visible
  const drawn = (root) => {
    let n = 0;
    const walk = (o, vis) => {
      const v = vis && o.visible;
      if (!v) return;
      const geo = o.geometry;
      if (o.isMesh && geo) {
        const idx = geo.index, pos = geo.attributes && geo.attributes.position;
        if (pos) n += (idx ? idx.count : pos.count) / 3 * (o.isInstancedMesh ? o.count : 1);
      }
      for (const c of o.children) walk(c, v);
    };
    walk(root, true);
    return Math.round(n);
  };
  const all = scene.children.map((c) => ({
    name: c.name || c.type + '#' + (c.id % 1000), tris: drawn(c),
  })).sort((x, y) => y.tris - x.tris);
  const actors = (G.actors || []).map((a) => {
    const r = a.character && a.character.root;
    const tiers = [];
    if (a.character) for (const k of ['hero', 'game', 'far']) {
      const t = a.character[k] || (a.character.tiers && a.character.tiers[k]);
      if (t && t.root) tiers.push(`${k}:${t.root.visible ? 'ON' : 'off'}:${drawn(t.root)}`);
    }
    return { name: 'actor', tris: r ? drawn(r) : 0, tiers: tiers.join(' ') };
  });
  g.debug.unfreeze();
  return { all, actors, drawnTotal: all.reduce((s, x) => s + x.tris, 0) };
});
if (rows.err) { console.log('ERR', rows.err); } else {
  console.log('DRAWN triangles:', rows.drawnTotal.toLocaleString(), '   (renderer.info said ~790k)\n');
  console.log('--- top-level scene objects (visible only) ---');
  for (const r of rows.all.slice(0, 18)) console.log(`  ${String(r.tris).padStart(9)}  ${r.name}`);
  console.log('\n--- characters (visible only) ---');
  for (const a of rows.actors) console.log(`  ${String(a.tris).padStart(8)}  ${a.name}   ${a.tiers}`);
}
await b.close();
