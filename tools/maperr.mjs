// Map a minified bundle position back to real source, for stack traces reported from a device with no console.
//
// The phone reports errors through window.__beacon (index.html) into the dev server's log as URL-encoded text; the
// stack frames in it look like `http://host/src/main.js:265:8564`, which is meaningless in a minified build. Feed the
// positions here against the sourcemap tools/bundle.mjs writes and you get the original file, line and symbol.
//
// usage: node tools/maperr.mjs <line:col> [line:col ...]
//        node tools/maperr.mjs --decode "boot%3A%20TypeError..."   (a raw URL-encoded beacon line)
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAP = path.join(ROOT, 'dist/src/main.js.map');
if (!fs.existsSync(MAP)) {
  console.error(`no ${path.relative(ROOT, MAP)} — run: node tools/bundle.mjs`);
  process.exit(1);
}
const map = new TraceMap(JSON.parse(fs.readFileSync(MAP, 'utf8')));

const args = process.argv.slice(2);
const decoded = args.includes('--decode');
const items = decoded
  ? decodeURIComponent(args[args.indexOf('--decode') + 1])
      .split('\n')
      .map((s) => (s.match(/(\d+):(\d+)\)?/) || []).slice(1))
      .filter((m) => m.length === 2)
      .map(([l, c]) => `${l}:${c}`)
  : args;

console.log(decoded ? 'decoded beacon:\n  ' + decodeURIComponent(args[args.indexOf('--decode') + 1]).replace(/\n/g, '\n  ') + '\n' : '');
for (const a of items) {
  const m = String(a).match(/^(\d+):(\d+)$/);
  if (!m) continue;
  const pos = originalPositionFor(map, { line: +m[1], column: +m[2] });
  const where = pos.source ? path.relative(ROOT, pos.source) : '(unmapped)';
  console.log(`bundle ${m[1]}:${m[2]}  ->  ${where}:${pos.line ?? '?'}:${pos.column ?? '?'}  ${pos.name || ''}`);
}
