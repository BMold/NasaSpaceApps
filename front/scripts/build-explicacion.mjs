// Generates the root explicacion.html as a single self-contained file, so it also
// works when opened directly from disk (file://), without a dev server.
import { readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const bundle = await build({
  entryPoints: [new URL('src/explicacion/main.ts', root).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
  bundle: true,
  format: 'iife',
  minify: true,
  target: 'es2020',
  charset: 'utf8',
  write: false,
});
const js = bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = read('src/explicacion/explicacion.css');

const html = read('src/explicacion/template.html')
  .replace('<!-- CSS -->', () => `<style>\n${css}</style>`)
  .replace('<!-- JS -->', () => `<script>${js}</script>`);

writeFileSync(new URL('explicacion.html', root), html);
console.log(`explicacion.html generated (${Math.round(html.length / 1024)} KB)`);
