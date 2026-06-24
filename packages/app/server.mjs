#!/usr/bin/env node
/**
 * Production static server for packages/app/dist — dependency-free Node, the missing production host
 * (vite preview is dev-only). Sends the EXACT COOP/COEP/CORP + CSP headers from headers.config.mjs on
 * every response (cross-origin isolation is load-bearing: drop COEP and SharedArrayBuffer/threaded
 * WASM/OPFS all break). Correct MIME for .mjs/.wasm/.woff2, long-cache for hashed assets + toolchain,
 * and an SPA fallback for deep links — but NEVER masking a missing /toolchain/*.mjs with index.html.
 *
 *   PORT=8080 node packages/app/server.mjs     (or: pnpm --filter @sparklab/app serve)
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { securityHeaders } from './headers.config.mjs';

const ROOT = fileURLToPath(new URL('./dist', import.meta.url));
const PORT = Number(process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.hex': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function cacheFor(pathname) {
  // The service worker + manifest must revalidate so a new deploy's SW is picked up (never long-cached).
  if (pathname === '/sw.js' || pathname.endsWith('.webmanifest')) return 'no-cache';
  if (pathname.startsWith('/assets/')) return 'public, max-age=31536000, immutable'; // hashed → immutable
  if (pathname.startsWith('/toolchain/'))
    return pathname.endsWith('manifest.json') ? 'no-cache' : 'public, max-age=604800';
  // ESP32 classic (Xtensa) client toolchain (~100MB) — long-cache the .mjs blobs, revalidate the sdk JSON.
  if (pathname.startsWith('/esp32-classic-toolchain/'))
    return pathname.endsWith('.json') ? 'no-cache' : 'public, max-age=604800';
  if (pathname === '/' || pathname.endsWith('.html')) return 'no-cache';
  return 'public, max-age=3600';
}

async function tryFile(p) {
  try {
    if ((await stat(p)).isFile()) return p;
  } catch {
    /* not found */
  }
  return null;
}

const server = createServer(async (req, res) => {
  const setHeaders = (extra = {}) => {
    for (const [k, v] of Object.entries(securityHeaders)) res.setHeader(k, v);
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  };
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    const filePath = join(ROOT, safe);
    if (!filePath.startsWith(ROOT)) {
      res.statusCode = 403;
      setHeaders({ 'Content-Type': 'text/plain' });
      return res.end('Forbidden');
    }

    let resolved = pathname.endsWith('/')
      ? await tryFile(join(filePath, 'index.html'))
      : await tryFile(filePath);
    // SPA fallback for extensionless routes only — a missing /toolchain/cc1.mjs stays a real 404,
    // never index.html (which would silently mask a broken toolchain ship).
    if (!resolved && !extname(pathname)) resolved = await tryFile(join(ROOT, 'index.html'));
    if (!resolved) {
      res.statusCode = 404;
      setHeaders({ 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }

    const body = await readFile(resolved);
    setHeaders({
      'Content-Type': MIME[extname(resolved)] || 'application/octet-stream',
      'Cache-Control': cacheFor(pathname),
    });
    res.statusCode = 200;
    res.end(body);
  } catch (e) {
    res.statusCode = 500;
    setHeaders({ 'Content-Type': 'text/plain' });
    res.end('Server error');
    console.error(e);
  }
});

server.listen(PORT, () => {
  console.log(
    `Sparklab production server → http://localhost:${PORT}  (COOP/COEP/CSP enforced, serving ./dist)`,
  );
});
