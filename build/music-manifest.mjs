// Scans songs/ and writes songs/manifest.json for the music engine (src/audio/music.js):
//   songs/in game/*       → played during matches (shuffled)
//   songs/now or never/*  → played once when one minute is left
//   songs/lobby/*         → played on the lobby / menu screens (shuffled)
// Each track gets a gain that brings it to the synth soundtrack's loudness (~−14 LUFS), measured with ffmpeg when it
// is installed (brew install ffmpeg); without it tracks play at their own level. Run: npm run music
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/Users/…", which path.join then turns into the
// unusable "C:\C:\Users\…". The same pattern is fixed in tools/audio-test.mjs.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SONGS = path.join(ROOT, 'songs');
const FOLDERS = { battle: 'in game', battle_final: 'now or never', menu: 'lobby' };   // menu = lobby screens (shuffled)
const AUDIO = /\.(mp3|m4a|aac|ogg|opus|wav|flac)$/i;
const TARGET_LUFS = -14, MAX_PEAK_DB = -1;

function loudness(file) {
  // ffmpeg prints the EBU R128 summary on stderr
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'], { encoding: 'utf8' });
  return r.error ? null : parse(r.stderr || '');
}
function parse(log) {
  const i = log.match(/^\s+I:\s+(-?[\d.]+) LUFS/m), p = log.match(/^\s+Peak:\s+(-?[\d.]+) dBFS/m);
  return i ? { lufs: +i[1], peak: p ? +p[1] : 0 } : null;
}

const manifest = { generated: new Date().toISOString(), targetLufs: TARGET_LUFS, tracks: {} };
let warned = false;
for (const [id, folder] of Object.entries(FOLDERS)) {
  const dir = path.join(SONGS, folder);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => AUDIO.test(f)).sort() : [];
  manifest.tracks[id] = files.map((f) => {
    const m = loudness(path.join(dir, f));
    if (!m && !warned) { warned = true; console.warn('[music] ffmpeg not found or failed: tracks will play un-normalised'); }
    // bring to target loudness, but never push the peak above −1 dBFS
    const gainDb = m ? +Math.min(TARGET_LUFS - m.lufs, MAX_PEAK_DB - m.peak).toFixed(1) : 0;
    const title = f.replace(AUDIO, '').replace(/\s*-\s*Splash!.*$/i, '').trim();
    console.log(`[music] ${id.padEnd(12)} ${(gainDb >= 0 ? '+' : '') + gainDb} dB  ${f}`);
    return { url: ['songs', folder, f].map(encodeURIComponent).join('/'), title, gainDb };
  });
}
fs.writeFileSync(path.join(SONGS, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`[music] wrote songs/manifest.json (${manifest.tracks.battle.length} match songs, ${manifest.tracks.battle_final.length} final-minute)`);
