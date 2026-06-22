// Copy non-TS renderer assets (index.html) into dist so Electron's loadFile
// finds them next to the compiled JS. tsc only emits .ts -> .js.
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist/renderer', { recursive: true });
copyFileSync('renderer/index.html', 'dist/renderer/index.html');
