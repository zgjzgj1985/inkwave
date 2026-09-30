// Run one of the Python helpers with whichever interpreter this machine actually has.
//
// `python3` is not portable: it is the normal name on macOS/Linux, but on Windows PATH often holds a Microsoft Store
// *stub* named python3 that is not an interpreter at all — and it fails in the worst possible way. It does not error
// with ENOENT, so a plain spawn looks fine; it just exits nonzero with empty output, which turns `npm run serve`
// into "the server never came up and nothing said why". Probe by actually running something, never by name or ENOENT.
//
// usage (from package.json): node tools/py.mjs tools/serve.py 8490
import { spawnSync } from 'node:child_process';

const [script, ...rest] = process.argv.slice(2);
if (!script) {
  console.error('py.mjs: no script given — usage: node tools/py.mjs <script.py> [args...]');
  process.exit(2);
}

// PYTHON wins so a specific interpreter can be forced; `py` is the Windows launcher, `python` the common cross-platform name.
const CANDIDATES = [process.env.PYTHON, 'python3', 'python', 'py'].filter(Boolean);

function works(cmd) {
  const probe = spawnSync(cmd, ['-c', 'print(1)'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0 && (probe.stdout || '').trim() === '1';
}

const py = CANDIDATES.find(works);
if (!py) {
  console.error(`py.mjs: no working Python found. Set PYTHON to your interpreter. Tried: ${CANDIDATES.join(', ')}`);
  process.exit(2);
}

const run = spawnSync(py, [script, ...rest], { stdio: 'inherit' });
process.exit(run.status ?? 1);
