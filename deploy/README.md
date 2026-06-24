# Deploying Sparklab

The app is a static SPA (`packages/app/dist`) that **requires** cross-origin isolation headers —
`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` (+ a strict
CSP). Without them the browser drops `crossOriginIsolated`, `SharedArrayBuffer` disappears, and the
in-browser compiler + emulator stop working. A naive static upload that omits these headers ships a
**broken** app. Everything below sends the correct headers.

Single source of truth for the headers: [`packages/app/headers.config.mjs`](../packages/app/headers.config.mjs)
(a drift guard, `deploy-headers.test.ts`, keeps every artifact in sync).

## 1. Build (required before any deploy)

```bash
bash scripts/build-deploy.sh
```

This installs, regenerates the **62 MB client toolchain** into `public/toolchain` (the footgun: a
plain `vite build` without it produces a `dist/` whose in-browser compile 404s), builds the app, then
**hard-fails** if the toolchain didn't ship and runs the self-host guard. Output: `packages/app/dist`.

## 2. Serve — pick one

| Option                         | Command                                                                                  | Notes                                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Node (zero-dep)**            | `PORT=8080 node packages/app/server.mjs` (or `pnpm --filter @sparklab/app serve`)        | Sends COOP/COEP/CORP+CSP on every response, correct MIME, SPA fallback.                    |
| **Docker + nginx**             | `docker build -f deploy/Dockerfile -t sparklab . && docker run --rm -p 8080:80 sparklab` | Headers repeated per location (nginx `add_header` non-inheritance).                        |
| **Netlify / Cloudflare Pages** | publish `packages/app/dist`                                                              | `public/_headers` + `public/_redirects` are copied into `dist/` and applied automatically. |
| **Any static host / CDN**      | upload `dist/`                                                                           | You MUST configure COOP/COEP/CORP + the CSP yourself, or isolation breaks.                 |

## 3. Verify the live deploy

```bash
node scripts/verify-deploy.mjs https://your-deploy-url
```

Checks the response headers, that `/toolchain/manifest.json` is real JSON (not an SPA-fallback HTML
masking a missing toolchain), and — if Playwright is installed — that the page is actually
`crossOriginIsolated` with a working `SharedArrayBuffer` in real Chromium.

## On a VPS with aaPanel 8.x (Ubuntu 20, Nginx)

aaPanel does NOT add cross-origin isolation headers, so the app is broken until you add them. Steps:

1. **Build locally** (the 62 MB toolchain needs `ci/toolchain-builder/out`, not on the VPS):
   ```bash
   pnpm build:deploy
   ```
2. **Upload** `packages/app/dist/` to the site root (`/www/wwwroot/<domain>`):
   ```bash
   VPS_HOST=root@your.ip VPS_PATH=/www/wwwroot/your-domain.com bash scripts/deploy-vps.sh
   ```
   (or use aaPanel's File Manager — but rsync handles the 62 MB toolchain better.)
3. **Create the site** in aaPanel (Website → Add site, pure static / no PHP), root = the path above.
4. **SSL** (required — COEP needs https): aaPanel → site → SSL → Let's Encrypt, then **Force HTTPS**.
5. **Headers**: aaPanel → site → Config. Delete the default `location / { }` and paste the four
   location blocks from [`aapanel-nginx.conf`](./aapanel-nginx.conf). Save (aaPanel reloads nginx).
6. **Open the firewall** (aaPanel → Security and your VPS provider): ports 80 + 443.
7. **Verify** from your machine:
   ```bash
   pnpm verify:deploy https://your-domain.com
   ```
   It must report `crossOriginIsolated + SharedArrayBuffer available`. If not, the headers aren't
   reaching the browser (check the site config + that you're on https).

## Notes / pitfalls

- **COEP is load-bearing** — drop it and `SharedArrayBuffer` (hence the whole engine) disappears.
- **Ship the toolchain** — `dist/toolchain` (~62 MB) must be uploaded; long-cache it, but keep
  `manifest.json` revalidated.
- **No CDNs** — wokwi-elements + fonts are bundled/self-hosted; `check-dist-selfhost.mjs` enforces it.
- `connect-src 'self' https: wss:` intentionally allows the user's IoT endpoints (Stage 6 MQTT/HTTP);
  CSP gates scripts/objects/frames, not data exfiltration — an accepted, documented trade-off.
