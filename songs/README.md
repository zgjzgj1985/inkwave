# songs/ — your own music (optional)

INKWAVE generates its whole soundtrack in code. If you'd rather play your own recordings, drop audio files into these
folders and run `npm run music` (it also runs before `npm start` / `npm run package`):

| folder | plays |
|---|---|
| `songs/in game/` | during matches (shuffled) |
| `songs/now or never/` | once when one minute is left |
| `songs/lobby/` | on the lobby / menu screens (shuffled) |

`npm run music` writes `songs/manifest.json` and, when `ffmpeg` is installed, levels every track to the synth
soundtrack's loudness. Audio files and the manifest are git-ignored: only add music you have the rights to.
