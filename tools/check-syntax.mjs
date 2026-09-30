// Syntax gate over every JS file the project ships or runs.
//
// This used to be an inline npm script — `for f in $(find …); do node --check "$f" || exit 1; done` — which is POSIX
// shell. npm runs scripts through cmd.exe on Windows, where that line is a syntax error ("f was unexpected at this
// time"), so the gate could not run there at all. A node script behaves identically on every platform and can report
// every failing file at once instead of dying on the first.
import { readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOTS = ['src', 'electron', 'build', 'tools', 'server/src'];
const EXTS = new Set(['.js', '.mjs', '.cjs']);
const SKIP = new Set(['node_modules', '.git', '.botlab', 'dist']);

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }   // a missing root is not an error
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXTS.has(extname(e.name))) out.push(p);
  }
  return out;
}

const files = ROOTS.flatMap((r) => walk(r)).sort();
const failed = [];

for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) failed.push({ f, msg: (r.stderr || r.stdout || '').trim() });
}

if (failed.length) {
  for (const { f, msg } of failed) console.error(`\n${relative(process.cwd(), f)}\n${msg}`);
  console.error(`\nsyntax FAILED: ${failed.length} of ${files.length} files`);
  process.exit(1);
}
console.log(`syntax ok (${files.length} files)`);
