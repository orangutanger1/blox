// Copy non-TS renderer assets (index.html) into dist so Electron's loadFile
// finds them next to the compiled JS. tsc only emits .ts -> .js.
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist/renderer', { recursive: true });
copyFileSync('renderer/index.html', 'dist/renderer/index.html');

// The preload is hand-written CommonJS (Electron needs a CJS preload under the
// sandbox); tsc doesn't emit it, so copy it next to the compiled main.
mkdirSync('dist/main', { recursive: true });
copyFileSync('main/preload.cjs', 'dist/main/preload.cjs');
