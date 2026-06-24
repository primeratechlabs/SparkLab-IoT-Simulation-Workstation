# SparkLab — IoT Simulation Workstation

SparkLab turns a Chromium browser into a self-contained workstation that **compiles real
Arduino/ESP32 firmware, emulates the MCU, and simulates the circuit — 100% client-side**. No
backend compile, no server round-trips: the C/C++ toolchain, the CPU interpreter, and the circuit
engine all run in the browser (WebAssembly + Web Workers + OPFS).

A free, self-hostable alternative to cloud simulators — your code never leaves the browser.

> A product of **PRIMERA TECH LABS COMPANY LIMITED**. Licensed under **AGPL-3.0** (see [License](#license)).

---

## Features

- **Real client-side build.** The actual `avr-gcc` (AVR) and `clang`/`lld` (ESP32) toolchains,
  compiled to WebAssembly, produce a real ELF/HEX — not a canned response.
- **Cycle-accurate emulation.** Arduino Uno on [avr8js](https://github.com/wokwi/avr8js); ESP32
  classic (Xtensa LX6) on an in-house interpreter that links real picolibc/libm. Firmware drives the
  on-screen pins/devices via net-trace.
- **Drag-and-drop circuit editor** using vendored `@wokwi/elements`, with ERC (electrical-rule check)
  gating runs.
- **Networking** for ESP32 sketches: virtual WiFi + direct browser MQTT/HTTP/Blynk (Tier 1 simulated /
  Tier 2 real-internet), plus an optional self-hosted egress gateway for raw-TCP brokers.
- **Installable PWA** — install to a standalone window, works offline after the first compile.
- **Reproducible, content-addressed builds** and self-hosted assets (no CDN, strict CSP).

## Supported boards

| Board | Arch | Status |
|---|---|---|
| Arduino Uno (ATmega328P) | AVR | ✅ |
| ESP32 (classic, WROOM) | Xtensa LX6 | ✅ |
| ESP32-C3 | RISC-V | 🚧 in development |

---

## ⚠️ Cross-origin isolation is required

The in-browser compiler and emulator need **`SharedArrayBuffer`** (threaded WebAssembly + OPFS sync
access), which the browser only grants when the page is **cross-origin isolated** — i.e. served over
**HTTPS** with these response headers on **every** resource:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

A host that omits them ships a **broken** app (the UI loads but nothing compiles). The dev server, the
bundled production server, and the configs under [`deploy/`](deploy/) all set them. See
[Deployment](#deployment).

---

## Repository layout

```
packages/        the app + engine (pnpm + turborepo monorepo)
  app/           the Vue 3 SPA (UI, workers, PWA)
  emulators/     avr8js runner, Xtensa/RISC-V interpreters, sim runtime
  build-orchestrator, toolchain-loader   in-browser compile/link pipeline
  schematic, sim-kernel, circuit, ...     circuit model, ERC, netlist, devices
services/gateway/  optional WS→TCP egress relay (raw-TCP brokers; default-deny anti-SSRF)
ci/toolchain-builder/  recipe that cross-builds the WASM toolchains (heavy, [CI])
deploy/          nginx / Apache / Docker configs + a deploy guide
e2e/             Playwright end-to-end tests
```

---

## Develop

Requires **Node ≥ 20** and **pnpm**.

```bash
pnpm install
pnpm dev          # vite dev server on http://localhost:5180 (sets COOP/COEP)
```

Tests / checks:

```bash
pnpm test         # unit (vitest)
pnpm e2e          # end-to-end (playwright)
pnpm typecheck && pnpm lint
```

### Building the client toolchains

The in-browser compilers (`avr-gcc`, `clang`/`lld`, and the SDK packs) are **large generated
artifacts**, not committed. They are cross-built to WebAssembly by the recipe in
[`ci/toolchain-builder/`](ci/toolchain-builder/) (a one-time, heavy step). Once their outputs exist,
a full deployable build is:

```bash
pnpm build:deploy   # generates fixtures + toolchains, builds the app, runs the deploy guards
                    # → packages/app/dist/
```

---

## Deployment

SparkLab is a **static SPA** (`packages/app/dist/`) — no backend. Serve it over HTTPS with the
cross-origin-isolation headers above + a strict CSP. Pick one:

- **Node (zero-dep):** `PORT=8080 node packages/app/server.mjs`
- **Docker + nginx:** `docker build -f deploy/Dockerfile -t sparklab . && docker run -p 8080:80 sparklab`
- **nginx / Apache (e.g. on aaPanel):** use [`deploy/aapanel-nginx.conf`](deploy/aapanel-nginx.conf) /
  [`deploy/aapanel-apache.conf`](deploy/aapanel-apache.conf).
- **Any static host / CDN:** upload `dist/` and configure the headers yourself.

The single source of truth for the headers is `packages/app/headers.config.mjs`. Verify a live deploy:

```bash
pnpm verify:deploy https://your-domain    # checks headers + real-browser crossOriginIsolated
```

See [`deploy/README.md`](deploy/README.md) for details.

---

## License

The **SparkLab application code** (this repository's own source) is licensed under the
**GNU Affero General Public License v3.0 (AGPL-3.0)** — see [`LICENSE`](LICENSE). Under AGPL section 13,
a deployed instance offers users a link to its Corresponding Source.

SparkLab also **bundles and serves third-party software under its own license**, including **GPL-3.0**
programs (the GCC / GNU Binutils WebAssembly toolchains) and **LGPL-2.1** Arduino cores. Those keep
their respective licenses (mere aggregation — the AGPL app *invokes* the GPL compilers, it does not
link them). Full inventory, license texts, and the GPL source offer:

- [`NOTICE`](NOTICE)
- `packages/app/public/THIRD-PARTY-NOTICES.txt`
- `packages/app/public/licenses/` (AGPL-3.0, GPL-3.0, LGPL-2.1, WRITTEN-OFFER)

---

© 2026 PRIMERA TECH LABS COMPANY LIMITED · contact@primeralabs.vn
