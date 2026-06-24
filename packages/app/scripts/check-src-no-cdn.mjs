#!/usr/bin/env node
/**
 * Source guard — fails if the app source introduces a CDN / third-party-script reference (e.g. a
 * reintroduced wokwi-elements unpkg tag or a Google Fonts link). Stage-6 IoT DATA endpoints (MQTT
 * over wss:, HTTP echo) are NOT CDNs — they go through connect-src and are not script sources — so
 * they are not matched. Catches the regression at source, before it ever reaches dist.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const CDN_HOSTS = [
  'unpkg.com',
  'cdn.jsdelivr.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdnjs.cloudflare.com',
  'esm.sh',
  'skypack.dev',
];
const SCAN = new Set(['.ts', '.vue', '.js', '.mjs', '.css', '.html']);

const fail = (m) => {
  console.error('✗ source CDN check FAILED:', m);
  process.exit(1);
};

async function walk(dir, out = []) {
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    if ((await stat(p)).isDirectory()) await walk(p, out);
    else if (SCAN.has(extname(p))) out.push(p);
  }
  return out;
}

for (const f of await walk(SRC)) {
  const txt = await readFile(f, 'utf8');
  for (const host of CDN_HOSTS) if (txt.includes(host)) fail(`${host} in ${f.slice(SRC.length)}`);
  if (/<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//i.test(txt))
    fail(`external <script src> in ${f.slice(SRC.length)}`);
}

console.log('✓ app source introduces no CDN / third-party-script references');
