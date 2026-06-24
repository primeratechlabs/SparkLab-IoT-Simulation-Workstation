import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';
// Security headers live in headers.config.mjs (single source) so the prod server + verifier + static
// hosts import the exact same values. Re-exported here for the dev/preview server config + the
// existing security-headers test.
import { coiHeaders, cspHeader } from './headers.config.mjs';

export { coiHeaders, cspHeader };

export default defineConfig({
  // wokwi-elements register custom elements (wokwi-*) — tell the Vue SFC compiler to treat them as
  // native elements (they are vendored/bundled, so the CSP script-src 'self' already covers them; no
  // CDN like the source design used). `sparklab-*` are our own vendored elements (e.g. the breadboard).
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag) => tag.startsWith('wokwi-') || tag.startsWith('sparklab-'),
        },
      },
    }),
    // PWA: installable + offline-after-first-use. Cross-origin isolation (COOP/COEP/CORP) is preserved
    // because Workbox caches the server responses verbatim — the precached index.html keeps COOP/COEP so
    // an SW-served page stays crossOriginIsolated (SharedArrayBuffer / the in-browser compiler survive).
    VitePWA({
      registerType: 'prompt', // a non-blocking "update" banner in App.vue — never reload mid-compile
      injectRegister: null, // registered manually via virtual:pwa-register (strict CSP: no inline script)
      includeAssets: ['favicon.png', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'SparkLab — IoT Simulation Workstation',
        short_name: 'SparkLab',
        description:
          'Biên dịch firmware + mô phỏng Arduino/ESP32 ngay trong trình duyệt. Sản phẩm của Primera Tech Labs.',
        lang: 'vi',
        theme_color: '#1a1a1a',
        background_color: '#f8f6f1',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        categories: ['education', 'developer'],
        icons: [
          { src: 'icons/pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: 'icons/maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Precache ONLY the ~3MB app shell — NOT the 60–160MB toolchains/fixtures (runtime-cached on demand).
        globPatterns: ['**/*.{js,css,html,woff2,wasm}'],
        globIgnores: [
          'toolchain/**',
          'esp32-classic-toolchain/**',
          'c3-toolchain/**',
          'fixtures/**',
          'licenses/**',
          '**/*.hex',
        ],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        inlineWorkboxRuntime: true, // self-contained sw.js (no importScripts of extra files) — CSP-clean
        cleanupOutdatedCaches: true,
        skipWaiting: false, // wait until the user accepts the update (no surprise reload)
        clientsClaim: true,
        navigateFallback: '/index.html',
        // Direct navigation to a real file (favicon, /licenses/*.txt, a toolchain blob) must hit the
        // network, never be masked by index.html. Anything with a file extension + the asset/toolchain
        // dirs are excluded; the app's own routes are query-params on "/" (no extension) so they fall back.
        navigateFallbackDenylist: [
          /\.[^/]+$/,
          /^\/(assets|toolchain|esp32-classic-toolchain|licenses)\//,
        ],
        runtimeCaching: [
          {
            // The client compilers (AVR ~61MB, ESP32-classic ~100MB) — cache on first compile so the SAME
            // board works offline next time; a user who only does Uno never downloads the ESP32 pack. Bump
            // cacheName v1→v2 ONLY when the toolchain itself is rebuilt (rare); app-code updates ride the
            // precache and don't touch this.
            urlPattern: ({ url }) =>
              url.pathname.startsWith('/toolchain/') ||
              url.pathname.startsWith('/esp32-classic-toolchain/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'sparklab-toolchain-v1',
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 90 },
            },
          },
        ],
      },
      devOptions: { enabled: false }, // PWA only in production build
    }),
  ],
  server: {
    headers: coiHeaders,
    port: 5180,
  },
  preview: {
    headers: { ...coiHeaders, ...cspHeader },
    port: 5181,
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // The OPFS SQLite build loads its own .wasm + async-proxy worker via import.meta.url;
    // pre-bundling breaks that resolution.
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
});
