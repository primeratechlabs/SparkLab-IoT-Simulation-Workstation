/**
 * useSimRunner — owns the compile → load → run → poll → stop lifecycle for a sketch, so components
 * stay presentational. Encapsulates the established getBuild()/getSim() worker plumbing and fixes the
 * lifecycle hazards the review flagged: it STOPS the emulator on unmount (no worker left running), is
 * re-entrant-safe (no double compile), guards the poll against worker errors + stale snapshots, and
 * resets transient state on each run.
 */
import { ref, onUnmounted } from 'vue';
import { getBuild } from '../lib/build-client';
import { getSim } from '../lib/sim-client';
import { friendlyFor } from '@sparklab/build-orchestrator';
import {
  BOARD_CATALOG,
  documentToNetlist,
  type CircuitDocument,
  type DeviceReflection,
} from '@sparklab/schematic';
import { DEFAULT_MQTT_WS_URL } from '@sparklab/network-shim';
import { type NetworkTier } from '../lib/network-transport';
import type { NetworkSnapshot } from '../workers/sim.worker';

export type RunnerStatus = 'idle' | 'compiling' | 'running' | 'error';

const POLL_MS = 150;
// A worker that fails to initialize (module-eval error / CSP worker-src rejection after a bad deploy)
// never answers, so an unguarded `await getSim()/getBuild()` would pin the UI in "đang biên dịch…"
// forever with no way out. These timeouts convert that hang into a clear, recoverable error. Compile is
// generous (a cold first run downloads tens of MB of toolchain + compiles WASM); plain RPCs are quick.
const COMPILE_TIMEOUT_MS = 180_000;
const WORKER_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(
      () =>
        reject(
          new Error(
            `${label} quá thời gian (${Math.round(ms / 1000)}s) — bộ mô phỏng có thể không khởi động được. Hãy tải lại trang.`,
          ),
        ),
      ms,
    );
    p.then(
      (v) => {
        window.clearTimeout(t);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Common Blynk auth-token placeholders shipped in templates/examples — these never reach the real cloud. */
const BLYNK_PLACEHOLDER = /YourBlynkToken|YOUR_AUTH_TOKEN|YourAuthToken|"YourAuthToken"/i;

/**
 * Decide the network tier a run actually uses, plus any user-facing notes (Blynk root-cause fix).
 *
 * Dashboard→device Blynk control (a switch on V0 lighting an LED) ONLY works on the 'real' tier: on the
 * default offline 'fake' tier the firmware's `GET /external/api/get?V0` is answered by a local loopback
 * that NOTHING populates from the real dashboard, so the device can never see the switch — yet the fake
 * presence still reports "online", which misleads the user. So when a sketch uses Blynk with a REAL token
 * but is left on 'fake', we auto-route it to the real Internet and DISCLOSE the switch (the dropdown also
 * flips to "🌐 Internet thật", so the egress is visible, not silent). A placeholder token stays offline
 * (there is no real device to talk to) with a note to set the real token. Pure → unit-tested directly.
 */
export function resolveNetworkTier(
  sketch: string,
  selected: NetworkTier,
): { tier: NetworkTier; notes: string[]; autoSwitched: boolean } {
  const usesBlynk = /\bBlynk\b|blynk\.cloud/i.test(sketch);
  const placeholderToken = BLYNK_PLACEHOLDER.test(sketch);
  const notes: string[] = [];

  if (usesBlynk && selected === 'fake') {
    if (placeholderToken) {
      notes.push(
        'Token Blynk vẫn là placeholder — thay "YourBlynkToken" bằng auth token THẬT của thiết bị (#define BLYNK_AUTH_TOKEN "..."). Trình mô phỏng giữ ở mạng ảo (offline) cho tới khi có token thật.',
      );
      return { tier: 'fake', notes, autoSwitched: false };
    }
    notes.push(
      'Sketch dùng Blynk → đã TỰ CHUYỂN lớp mạng sang "🌐 Internet thật" để điều khiển/đồng bộ với dashboard Blynk THẬT (firmware kết nối blynk.cloud; switch trên dashboard sẽ tác động thiết bị). Muốn chạy ngoại tuyến thì chọn lại "📶 Mạng ảo" trước khi chạy.',
    );
    return { tier: 'real', notes, autoSwitched: true };
  }

  // On the real tier, a placeholder token will 400 on the cloud → warn (run() silently skips otherwise).
  if (usesBlynk && selected === 'real' && placeholderToken) {
    notes.push(
      'Token Blynk vẫn là placeholder — thay "YourBlynkToken" bằng auth token THẬT của thiết bị thì cloud mới chấp nhận và dashboard mới điều khiển được.',
    );
  }
  return { tier: selected, notes, autoSwitched: false };
}

export function useSimRunner() {
  const status = ref<RunnerStatus>('idle');
  const running = ref(false);
  const message = ref('');
  /** Non-fatal build notes (e.g. a library substituted by a built-in shim) — shown so the swap is never silent. */
  const buildNotes = ref<string[]>([]);
  const serial = ref('');
  const ledOn = ref(false);
  const pins = ref<Record<number, 0 | 1>>({}); // every driven digital pin → level (UI reflects per wired pin)
  const ledToggles = ref(0);
  const vtimeMs = ref(0);
  const devices = ref<Record<string, DeviceReflection>>({}); // drawn-device visible state (servo angle, LCD text, …)
  const pwmDuty = ref<Record<number, number>>({}); // PWM duty 0..1 per pin/channel
  // Network tier for ESP32 runs: 'fake' (Tier 1, offline — default; WiFi sketches connect with no egress)
  // or 'real' (Tier 2 — the real Internet, opt-in). `network` is the polled WiFi/MQTT snapshot for the UI.
  const networkTier = ref<NetworkTier>('fake');
  const network = ref<NetworkSnapshot | null>(null);
  let netActive = false; // true only during an ESP32 run with a tier ≠ 'off' (AVR has no network to poll)

  let timer: number | undefined;
  let gen = 0; // run/stop generation token — bumping it cancels an in-flight run()
  function stopPolling(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }
  function startPolling(): void {
    stopPolling();
    timer = window.setInterval(() => {
      const tick = timer;
      void getSim()
        .getState()
        .then((s) => {
          if (timer !== tick) return; // a stop()/restart happened during the await — drop stale snapshot
          pins.value = s.pins ?? {};
          ledOn.value = !!s.pin13;
          ledToggles.value = s.ledToggles;
          serial.value = s.serial;
          running.value = s.running;
          vtimeMs.value = s.virtualTimeMs;
          devices.value = s.devices ?? {};
          pwmDuty.value = s.pwmDuty ?? {};
          if (!s.running) {
            stopPolling();
            if (s.halted) {
              // The firmware trapped (unimplemented instruction / abort) — surface it, don't pretend success.
              status.value = 'error';
              message.value = `Firmware dừng giữa chừng: ${s.haltReason ?? 'lỗi thực thi'}`;
            } else if (status.value === 'running') {
              status.value = 'idle';
            }
          }
          if (netActive)
            void getSim()
              .getNetworkState()
              .then((n) => {
                if (timer === tick) network.value = n;
              });
        })
        .catch((e: unknown) => {
          stopPolling();
          running.value = false;
          status.value = 'error';
          message.value = `Mất kết nối bộ mô phỏng: ${(e as Error).message}`;
        });
    }, POLL_MS);
  }

  /**
   * Compile the sketch and start the emulator. No-op if already compiling/running (re-entrancy).
   * A `stop()` or a newer `run()` during the multi-second compile bumps `gen`, so this run abandons
   * itself at the next checkpoint instead of starting a "zombie" emulator the user already stopped.
   */
  async function run(
    sketch: string,
    boardId = 'arduino-uno',
    doc: CircuitDocument | null = null,
  ): Promise<void> {
    if (status.value === 'compiling' || status.value === 'running') return;
    // Route the build/emulator by board architecture — never silently compile+run AVR for another
    // arch. AVR (Uno) → avr-gcc HEX; ESP32-C3 (RISC-V) and ESP32-classic (Xtensa) → clang+lld ELF on
    // their interpreters. All three are 100% client-side (I8); any other arch is a clear error.
    const arch = BOARD_CATALOG[boardId]?.architecture ?? 'avr';
    if (arch !== 'avr' && arch !== 'riscv32' && arch !== 'xtensa') {
      status.value = 'error';
      running.value = false;
      message.value = `Chạy mô phỏng hỗ trợ Arduino Uno (AVR) + ESP32-C3 (RISC-V) + ESP32 (Xtensa). ${BOARD_CATALOG[boardId]?.displayName ?? boardId} (${arch}) chưa có backend client-side — sẽ bổ sung ở giai đoạn sau.`;
      return;
    }
    // Safety verdict (AUD-010): block the run on ANY ERC error, by severity policy — not a hard-coded rule
    // list — so a new error-severity rule blocks automatically; warnings are shown but allowed. If the
    // document can't even be converted to a netlist, fail closed (we cannot validate it → must not run).
    if (doc) {
      let erc: ReturnType<typeof documentToNetlist>['erc'];
      try {
        erc = documentToNetlist(doc).erc;
      } catch (e) {
        status.value = 'error';
        running.value = false;
        message.value = `Không chạy — không dựng được netlist từ mạch: ${(e as Error).message}. Hãy sửa mạch rồi chạy lại.`;
        return;
      }
      const blocking = erc.find((f) => f.severity === 'error');
      if (blocking) {
        status.value = 'error';
        running.value = false;
        message.value = `Không chạy — mạch có lỗi (${blocking.rule}): ${blocking.message}. Hãy sửa rồi chạy lại.`;
        return;
      }
    }
    const myGen = ++gen;
    status.value = 'compiling';
    buildNotes.value = [];
    message.value =
      arch === 'riscv32'
        ? 'Đang tải bộ công cụ ESP32-C3 + biên dịch…'
        : arch === 'xtensa'
          ? 'Đang tải bộ công cụ ESP32 (Xtensa) + biên dịch…'
          : 'Đang biên dịch…';
    serial.value = '';
    ledOn.value = false;
    pins.value = {};
    ledToggles.value = 0;
    vtimeMs.value = 0;
    devices.value = {};
    pwmDuty.value = {};
    network.value = null;
    try {
      await withTimeout(getSim().stop(), WORKER_TIMEOUT_MS, 'Khởi động bộ mô phỏng'); // clean slate; also catches a sim worker that never inits
      if (myGen !== gen) return;
      // Select the network tier for ESP32 BEFORE the load (the runner binds C3Net to the transport at
      // construction). AVR has no network. 'real' = real-Internet egress (Tier 2). A Blynk sketch with a
      // real token left on the offline default is auto-routed to 'real' so dashboard→device control works
      // (the dropdown flips too, so the egress is disclosed) — see resolveNetworkTier.
      const tierPlan =
        arch !== 'avr'
          ? resolveNetworkTier(sketch, networkTier.value)
          : { tier: networkTier.value, notes: [] as string[], autoSwitched: false };
      if (tierPlan.tier !== networkTier.value) networkTier.value = tierPlan.tier; // reflect in the UI dropdown
      netActive = arch !== 'avr' && networkTier.value !== 'off';
      if (arch !== 'avr') {
        await getSim().setNetworkTier(
          networkTier.value,
          networkTier.value === 'real' ? { mqttWsUrl: DEFAULT_MQTT_WS_URL } : {},
        );
        if (myGen !== gen) return;
      }
      // Bind the drawn circuit so the emulator instantiates + attaches its devices (the root-cause
      // fix: DHT/LCD/servo/HC-SR04 the user drew now reach the firmware + reflect back). Deep-clone to
      // a plain object — the doc is a Vue reactive proxy and Comlink's postMessage can't clone that.
      const plainDoc = doc ? (JSON.parse(JSON.stringify(doc)) as CircuitDocument) : null;
      await getSim().attachCircuit(plainDoc, boardId);
      if (myGen !== gen) return;
      if (arch !== 'avr') {
        // ESP32 (C3 RISC-V / classic Xtensa): compile to a firmware ELF; the sim worker picks the
        // matching interpreter from the ELF's e_machine. One seam serves both SoCs.
        const img = await withTimeout(
          getBuild().compileToImage(sketch, boardId),
          COMPILE_TIMEOUT_MS,
          'Biên dịch',
        );
        if (myGen !== gen) return;
        if (img.error || !img.elf) {
          status.value = 'error';
          message.value =
            img.error ??
            (arch === 'xtensa'
              ? 'Biên dịch ESP32 (Xtensa) thất bại'
              : 'Biên dịch ESP32-C3 thất bại');
          return;
        }
        // disclose any built-in-shim substitution + the Blynk tier/token routing decided before the run.
        buildNotes.value = [...(img.notes ?? []), ...tierPlan.notes];
        await getSim().loadImage(img.elf, 'elf');
      } else {
        const res = await withTimeout(
          getBuild().compileToHex(sketch),
          COMPILE_TIMEOUT_MS,
          'Biên dịch',
        );
        if (myGen !== gen) return; // superseded during compile → abandon
        if (!res.hex) {
          status.value = 'error';
          const d = res.diagnostics?.[0];
          message.value = d
            ? (d.friendly ?? friendlyFor(d.message) ?? d.message)
            : 'Biên dịch thất bại';
          return;
        }
        await getSim().loadHex(res.hex);
      }
      if (myGen !== gen) return;
      await getSim().start();
      if (myGen !== gen) {
        void getSim().stop(); // started but already cancelled — undo
        return;
      }
      running.value = true;
      status.value = 'running';
      message.value = '';
      startPolling();
    } catch (e) {
      if (myGen !== gen) return; // a stop superseded us; don't clobber its state
      status.value = 'error';
      running.value = false;
      message.value = (e as Error).message || 'Không biên dịch được (thiếu toolchain?)';
    }
  }

  /** Press/release a button on a digital pin (only while running; the worker maps pressed→LOW). */
  function setButton(pin: number, pressed: boolean): void {
    if (running.value) void getSim().setButton(pin, pressed);
  }
  /** Set a potentiometer/analog input on an ADC channel, raw 0..1023 (only while running). */
  function setPot(channel: number, raw: number): void {
    if (running.value) void getSim().setPot(channel, raw);
  }
  /** Live-edit a drawn device's inspector prop (sensor stimulus / actuator setting) while running. */
  function setDeviceProp(cid: string, name: string, value: unknown): void {
    if (running.value) void getSim().setDeviceProp(cid, name, value);
  }

  async function stop(): Promise<void> {
    gen++; // cancel any in-flight run()
    stopPolling();
    await getSim().stop();
    running.value = false;
    status.value = 'idle';
  }

  onUnmounted(() => {
    stopPolling();
    void getSim().stop(); // never leave the emulator running after the workspace unmounts
  });

  return {
    status,
    running,
    message,
    buildNotes,
    serial,
    ledOn,
    pins,
    ledToggles,
    vtimeMs,
    devices,
    pwmDuty,
    networkTier,
    network,
    run,
    stop,
    setButton,
    setPot,
    setDeviceProp,
  };
}
