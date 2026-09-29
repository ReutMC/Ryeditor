/**
 * Ryeditor — assemble dist/renderer static assets:
 *  - index.html + styles.css from src/renderer
 *  - monaco-editor "vs" tree from node_modules
 *  - xterm UMD bundles + css from node_modules
 */
import { cpSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const out = join(root, 'dist/renderer');

mkdirSync(out, { recursive: true });

cpSync(join(root, 'src/renderer/index.html'), join(out, 'index.html'));
cpSync(join(root, 'src/renderer/styles.css'), join(out, 'styles.css'));

const monacoVs = join(root, 'node_modules/monaco-editor/min/vs');
if (existsSync(monacoVs)) {
  cpSync(monacoVs, join(out, 'vs'), { recursive: true });
} else {
  throw new Error('monaco-editor not installed (node_modules/monaco-editor missing)');
}

mkdirSync(join(out, 'vendor'), { recursive: true });
cpSync(join(root, 'node_modules/@xterm/xterm/lib/xterm.js'), join(out, 'vendor/xterm.js'));
cpSync(join(root, 'node_modules/@xterm/xterm/css/xterm.css'), join(out, 'vendor/xterm.css'));
cpSync(join(root, 'node_modules/@xterm/addon-fit/lib/addon-fit.js'), join(out, 'vendor/xterm-addon-fit.js'));

console.log('[ryeditor] renderer assets assembled -> dist/renderer');
