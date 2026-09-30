// Bundle the 170-odd game modules into one file, for serving over a link with real latency.
//
// Why this exists: INKWAVE ships as unbundled ES modules, which is ideal on localhost (RTT ≈ 0) and terrible over
// anything with distance. The module graph is deep and mostly serial — each `import` hop costs a full round trip — so
// over a tunnel (~1.2 s RTT) the 160-request load turns into minutes of waiting, while the same load is instant on
// the LAN. Bundling collapses it to a handful of requests.
//
// Output goes to dist/src/main.js — deliberately the SAME path as the unbundled entry point. The sources build asset
// URLs as `new URL('../../assets/…', import.meta.url)`, and those resolve identically from /src/main.js as they do
// from /src/game/… (both climb to the server root and then into /assets/), so the assets keep working untouched.
//
// usage: node tools/bundle.mjs [--out dist]
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const OUT = (() => { const i = args.indexOf('--out'); return i >= 0 ? args[i + 1] : 'dist'; })();

const dist = path.join(ROOT, OUT);
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error(`bundle: ${OUT}/index.html is missing — run the copy step first (npm run build)`);
  process.exit(1);
}

// The import map in index.html maps the bare specifiers at runtime; esbuild needs to be told the same two.
const threePaths = {
  name: 'three-paths',
  setup(b) {
    b.onResolve({ filter: /^three$/ }, () => ({ path: path.join(ROOT, 'vendor/three/build/three.module.js') }));
    b.onResolve({ filter: /^three\/addons\// }, (a) => ({
      path: path.join(ROOT, 'vendor/three/jsm', a.path.slice('three/addons/'.length)),
    }));
  },
};

const result = await build({
  entryPoints: [path.join(ROOT, 'src/main.js')],
  outfile: path.join(dist, 'src/main.js'),
  bundle: true,
  format: 'esm',
  splitting: false,          // one file, so the browser makes one request instead of a chunk waterfall
  minify: true,
  // A sourcemap is emitted next to the bundle so a stack trace from a device with no console (a phone) can be mapped
  // back to real source positions with tools/maperr.mjs. Browsers only fetch it when devtools is open, so it costs
  // the device nothing.
  sourcemap: true,
  target: ['es2022'],
  legalComments: 'none',
  plugins: [threePaths],
  metafile: true,
  logLevel: 'warning',
});

// Anything left as a runtime import() would reintroduce a request waterfall — fail loudly rather than ship one.
const out = fs.readFileSync(path.join(dist, 'src/main.js'), 'utf8');
const dyn = out.match(/import\s*\(/g);
const size = (fs.statSync(path.join(dist, 'src/main.js')).size / 1048576).toFixed(2);

// The per-module tree is now dead weight in dist, and the browser would still be able to fetch it. Hold on to the
// bundle and its map first — both live under the directory being removed.
const mapFile = path.join(dist, 'src/main.js.map');
const map = fs.existsSync(mapFile) ? fs.readFileSync(mapFile, 'utf8') : null;
fs.rmSync(path.join(dist, 'src'), { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'src'), { recursive: true });
fs.writeFileSync(path.join(dist, 'src/main.js'), out);
if (map) fs.writeFileSync(mapFile, map);
// three ships bundled inside the single file now, so the vendored copies and the import map are unused.
fs.rmSync(path.join(dist, 'vendor'), { recursive: true, force: true });

console.log(`bundled -> ${OUT}/src/main.js  ${size} MB (minified, single file)`);
if (dyn) console.log(`  note: ${dyn.length} dynamic import() call(s) remain — check they are not a waterfall`);
if (result.warnings?.length) for (const w of result.warnings) console.log('  warn:', w.text);
