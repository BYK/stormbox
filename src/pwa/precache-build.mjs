import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicRoot = new URL('../../public/', import.meta.url);

const shellFiles = [
  'apple-touch-icon.png',
  'favicon-32.png',
  'favicon.ico',
  'icon-192.png',
  'icon-512.png',
  'logo.png',
  'site.webmanifest',
  ...['fonts', 'icons'].flatMap((dir) => readdirSync(new URL(`${dir}/`, publicRoot), {
    recursive: true,
    withFileTypes: true,
  }).filter((entry) => entry.isFile()).map((entry) => {
    const parent = relative(fileURLToPath(publicRoot), entry.parentPath).split(sep).join('/');
    return `${parent}/${entry.name}`;
  })),
].sort();

/** The offline cache contains only build output and known public assets. */
export function precacheBuild() {
  return {
    name: 'stormbox-precache',
    apply: 'build',
    enforce: 'post',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const hash = createHash('sha256');
        const output = Object.keys(bundle).filter((path) =>
          path === 'index.html' || path === 'pdf-viewer.html'
          || (path.startsWith('assets/') && !path.endsWith('.map'))).sort();
        if (!output.includes('index.html')) throw new Error('Missing HTML for the Stormbox app shell');
        const files = [...shellFiles];
        const optionalFiles = [];
        for (const path of output) {
          const entry = bundle[path];
          hash.update(path).update(entry.type === 'chunk' ? entry.code : entry.source);
          if (/^assets\/(?:triage-model-worker|ort-wasm-simd-threaded|transformers\.web)[.-]/.test(path)) {
            optionalFiles.push(path);
          } else {
            files.push(path);
          }
        }
        for (const path of [...shellFiles, 'stormbox-sw.js', 'push-sw.js']) {
          hash.update(path).update(readFileSync(new URL(path, publicRoot)));
        }
        const manifest = { version: hash.digest('hex').slice(0, 24), files, optionalFiles };
        this.emitFile({
          type: 'asset',
          fileName: 'stormbox-precache.js',
          source: `self.stormboxPrecache = ${JSON.stringify(manifest)};\n`,
        });
      },
    },
  };
}
