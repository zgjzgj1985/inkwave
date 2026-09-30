// Locate the system Chrome for the puppeteer-core tools, on any OS.
//
// These tools drive the *system* Chrome rather than a bundled one (puppeteer-core ships no browser), and every tool
// used to hardcode `/Applications/Google Chrome.app/…` — so they only ran on the Mac they were written on. Resolve it
// once here instead: CHROME_PATH wins, then the usual install locations per platform, then a clear error naming what
// was tried (a silent wrong path shows up as a confusing puppeteer stack instead).
import { existsSync } from 'node:fs';

const CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  ],
  win32: [
    `${process.env['PROGRAMFILES']}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
};

export function chromePath() {
  const explicit = process.env.CHROME_PATH;
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`CHROME_PATH is set but does not exist: ${explicit}`);
    return explicit;
  }
  const tried = CANDIDATES[process.platform] || CANDIDATES.linux;
  for (const p of tried) if (p && existsSync(p)) return p;
  throw new Error(
    `No Chrome found. Set CHROME_PATH to your Chrome binary. Tried:\n  ${tried.filter(Boolean).join('\n  ')}`
  );
}

// GPU flags per platform. `--use-angle=metal` is the macOS backend; elsewhere ANGLE picks d3d11/gl by default and
// naming metal there just gets ignored (or errors on old builds), so only force it where it means something.
export function gpuArgs(extra = []) {
  const args = ['--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];
  if (process.platform === 'darwin') args.unshift('--use-angle=metal');
  return args.concat(extra);
}
