import { build } from 'esbuild';
import { readFileSync, mkdirSync } from 'node:fs';

const html = readFileSync('public/index.html', 'utf8');
mkdirSync('build', { recursive: true });

await build({
  entryPoints: ['server.js'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'build/server.cjs',
  banner: { js: 'globalThis.__INDEX_HTML__=' + JSON.stringify(html) + ';' },
  logLevel: 'info',
});
console.log('bundled -> build/server.cjs');
