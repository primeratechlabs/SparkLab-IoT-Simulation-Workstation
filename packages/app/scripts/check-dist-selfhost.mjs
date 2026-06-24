#!/usr/bin/env node
/**
 * Build-output self-host guard — fails the build if dist/ would pull anything from a CDN at runtime.
 * The source design loaded wokwi-elements + Google Fonts from CDNs; the shipped app must be 100%
 * self-hosted (invariant: self-host assets, no third-party script). Scans the text assets for known
 * CDN hosts + external <script>/<link> in index.html, and asserts the fonts shipped as bundled woff2.
 * The 62MB binary toolchain dir is skipped (not text).
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const CDN_HOSTS = [
  'unpkg.com',
  'cdn.jsdelivr.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdnjs.cloudflare.com',
  'esm.sh',
  'skypack.dev',
];
const TEXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.map', '.txt']);

const fail = (m) => {
  console.error('✗ self-host check FAILED:', m);
  process.exit(1);
};

async function walk(dir, out = []) {
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    if ((await stat(p)).isDirectory()) {
      if (name !== 'toolchain') await walk(p, out); // skip the large binary toolchain bundle
    } else out.push(p);
  }
  return out;
}

let files;
try {
  files = await walk(DIST);
} catch {
  fail(`dist/ not found at ${DIST} — run the build first`);
}

let woff2 = 0;
for (const f of files) {
  if (extname(f) === '.woff2') woff2++;
  if (!TEXT.has(extname(f))) continue;
  const txt = await readFile(f, 'utf8');
  for (const host of CDN_HOSTS)
    if (txt.includes(host)) fail(`${host} referenced in ${f.slice(DIST.length)}`);
}

const indexHtml = await readFile(join(DIST, 'index.html'), 'utf8');
if (/<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["']https?:\/\//i.test(indexHtml))
  fail('external <script>/<link> in index.html');
if (woff2 === 0) fail('no .woff2 fonts bundled — fonts are not self-hosted');

console.log(
  `✓ dist is self-hosted — no CDN hosts, ${woff2} bundled woff2, no external script/link in index.html`,
);
