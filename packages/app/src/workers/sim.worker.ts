/**
 * Simulation worker (invariant I2) — runs firmware off the main thread on virtual time (I3) and
 * exposes a polled snapshot (pins/serial/virtual-time + DEVICE state) + input setters via Comlink.
 *
 * Board-aware AND device-aware: the drawn circuit (a `CircuitDocument`, set via `attachCircuit`) is
 * instantiated into live `SimComponent`s and BOUND to the running emulator through the device-runtime
 * layer — the root-cause fix for the QA-CURRICULUM device failures (a DHT/LCD/servo/HC-SR04 the user
 * drew now actually reaches the firmware and reflects back). One device model runs on every backend:
 *   AVR (Uno)        → `Circuit`  (owns its AVRRunner + the CircuitHost the devices attach to)
 *   ESP32 SoC (C3/Xtensa) → `Rv32Runner`/`XtensaRunner` wrapped by `SocHost` (the same CircuitHost)
 * All fill the SAME SimState so the UI/canvas reflection is identical across boards. Reflection stays
 * truth: `pins` is driven ONLY by firmware GPIO writes; device stimulus uses the input seam and never
 * pollutes `pins`; device-visible state (servo angle, LCD text, PWM duty) is a SEPARATE channel.
 */

import * as Comlink from 'comlink';
import {
  parseIntelHex,
  Rv32Runner,
  XtensaRunner,
  elfMachine,
  EM_RISCV,
  EM_XTENSA,
} from '@sparklab/emulators';
import { Circuit, SocHost } from '@sparklab/circuit';
import type { NetworkTransport, MqttTransport, BlynkPresence } from '@sparklab/network-shim';
import {
  createNetworkTransport,
  wifiPhase,
  type NetworkTier,
  type WifiPhase,
} from '../lib/network-transport';
import {
  boardEntry,
  instantiateAttachedDevices,
  reflectDevices,
  applyDeviceProp,
  type AttachedDevice,
  type DeviceReflection,
  type CircuitDocument,
} from '@sparklab/schematic';

const VIRTUAL_MS_PER_TICK = 20; // advance 20ms of virtual time per scheduler tick
const WALL_MS_PER_TICK = 8; // ~2.5x realtime (faster-than-realtime is allowed)
// Circuit is the Uno (AVR) engine; avr8js exposes D0..D13 as digital ports (B/C/D). A0..A5 are ADC
// inputs, not digital-addressable — watching them throws, so only the 14 digital pins are reflected.
const AVR_WATCH_PINS = 14;

export type ImageFormat = 'intel-hex' | 'elf';

interface SimState {
  /** Digital pin → level for EVERY firmware-written GPIO pin, so the UI reflects the real circuit. */
  pins: Record<number, 0 | 1>;
  pin13: 0 | 1; // convenience alias (legacy SimLab/WorkbenchLab read it directly)
  ledToggles: number; // transitions of the BOARD's on-board LED pin (board-aware — CMB-11)
  serial: string;
  virtualTimeMs: number;
  running: boolean;
  /** Drawn-device visible state, keyed by component id (servo angle, LCD text, LED on, … — CMB-01..04). */
  devices: Record<string, DeviceReflection>;
  /** PWM duty as a 0..1 fraction, keyed by pin/channel (brightness fidelity — CMB-04, SoC ledcWrite). */
  pwmDuty: Record<number, number>;
  /** True if the firmware trapped (an unimplemented CPU instruction, or an abort). The run is dead — the
   *  UI must show this, not present the frozen pre-trap output as a successful run (anti-silent-fake). */
  halted: boolean;
  /** Plain-language cause of a halt (instruction/opcode + pc), or null. */
  haltReason: string | null;
}

function freshState(): SimState {
  return {
    pins: {},
    pin13: 0,
    ledToggles: 0,
    serial: '',
    virtualTimeMs: 0,
    running: false,
    devices: {},
    pwmDuty: {},
    halted: false,
    haltReason: null,
  };
}

/** Live network state the UI polls (WiFi phase + chosen tier + any real-broker connect error). */
export interface NetworkSnapshot {
  tier: NetworkTier;
  wifi: WifiPhase;
  mqttConnected: boolean;
  /** Blynk device session is live (device shows "online" on the dashboard). */
  blynkOnline: boolean;
  error: string | null;
}

let mode: 'avr' | 'soc' = 'avr';
let circuit: Circuit | null = null;
let socRunner: Rv32Runner | XtensaRunner | null = null;
let socHost: SocHost | null = null;
// Selected network tier + its transports (bound to the SoC runner's C3Net on the next load). Set via
// setNetworkTier BEFORE loadImage. The async Tier-2 fetch/WS resolves in the gap between tick() calls.
let netTier: NetworkTier = 'off';
let net: NetworkTransport | null = null;
let mqtt: MqttTransport | null = null;
let blynk: BlynkPresence | null = null;
let netError: string | null = null;
let devices: AttachedDevice[] = [];
let attachedDoc: CircuitDocument | null = null;
let onboardLedPin = 13;
let prevOnboard: 0 | 1 = 0;
let running = false;
let state: SimState = freshState();

function ready(): boolean {
  return mode === 'avr' ? circuit !== null : socRunner !== null;
}

/** Pull the attached devices' visible state + any PWM duty into the snapshot the UI polls. */
function reflectNow(): void {
  if (devices.length) state.devices = reflectDevices(devices);
  if (socHost && socHost.duty.size) {
    const d: Record<number, number> = {};
    for (const [ch, frac] of socHost.duty) d[ch] = frac;
    state.pwmDuty = d;
  }
}

function tick(): void {
  if (!running) return;
  if (mode === 'avr' && circuit) {
    circuit.run(VIRTUAL_MS_PER_TICK); // pins are pushed by the pin watchers; pull serial/time here
    const s = circuit.serial;
    state.serial = s.length > 4000 ? s.slice(-4000) : s;
    state.virtualTimeMs = circuit.runner.virtualTimeNs / 1e6;
  } else if (mode === 'soc' && socRunner) {
    socRunner.executeForMillis(VIRTUAL_MS_PER_TICK);
    // The firmware hit a CPU trap (unimplemented instruction or an abort). It is DEAD — stop the run and
    // surface the cause instead of leaving the loop spinning over frozen output (which would read as a
    // successful, complete run). Honesty over a silent fake.
    if (socRunner.halted && !state.halted) {
      state.halted = true;
      state.haltReason = socRunner.haltReason;
      running = false;
      state.running = false;
    }
    state.pins = { ...socRunner.pins };
    const lvl: 0 | 1 = socRunner.pins[onboardLedPin] ?? 0;
    if (lvl !== prevOnboard) {
      state.ledToggles++;
      prevOnboard = lvl;
    }
    state.pin13 = socRunner.pins[13] ?? 0;
    const s = socRunner.serial();
    const base = s.length > 4000 ? s.slice(-4000) : s;
    state.serial = state.halted
      ? `${base}\n\n[sim] ⚠ Firmware stopped: ${state.haltReason}\n`
      : base;
    state.virtualTimeMs = socRunner.virtualTimeNs / 1e6;
  }
  reflectNow();
  setTimeout(tick, WALL_MS_PER_TICK);
}

/** Instantiate the attached drawn devices (if any) — the bridge input both backends share. */
function attachDevices(addEach: (c: AttachedDevice) => void): void {
  devices = [];
  if (!attachedDoc) return;
  const r = instantiateAttachedDevices(attachedDoc);
  devices = r.devices;
  for (const d of devices) addEach(d);
}

/** AVR path: a `Circuit` (owns its AVRRunner + the CircuitHost) with the drawn devices attached. */
function prepareCircuit(bytes: Uint8Array): void {
  running = false;
  mode = 'avr';
  socRunner = null;
  socHost = null;
  state = freshState();
  prevOnboard = 0;
  circuit = new Circuit(bytes);
  attachDevices((d) => circuit!.add(d.component));
  // Firmware-driven GPIO → SimState.pins (board-aware on-board LED counter) for every digital pin.
  for (let pin = 0; pin < AVR_WATCH_PINS; pin++) {
    circuit.watchPin(pin, (level) => {
      const v: 0 | 1 = level === 'high' ? 1 : 0;
      if (state.pins[pin] === v) return;
      const seeded = pin in state.pins;
      state.pins[pin] = v;
      if (pin === 13) state.pin13 = v;
      if (seeded && pin === onboardLedPin) state.ledToggles++; // ignore the initial seed
    });
  }
  reflectNow();
}

/** ESP32 path: the matching interpreter (by e_machine) wrapped by SocHost, with devices attached. */
function prepareElf(elf: Uint8Array): void {
  running = false;
  mode = 'soc';
  circuit = null;
  state = freshState();
  prevOnboard = 0;
  // Reject an unsupported/corrupt architecture instead of silently running it as RISC-V (AUD-007). The
  // runner's elfLoad validates the rest of the header + segment bounds.
  const machine = elfMachine(elf);
  if (machine !== EM_RISCV && machine !== EM_XTENSA) {
    throw new Error(
      `Firmware ELF có kiến trúc không hỗ trợ (e_machine=${machine}; chỉ RISC-V/Xtensa).`,
    );
  }
  // Bind the selected network transport (if any) so the firmware's WiFi/HTTP/MQTT/Blynk HAL is serviced.
  const netOpts = net ? { transport: net, mqtt: mqtt ?? undefined, blynk: blynk ?? undefined } : {};
  socRunner = machine === EM_XTENSA ? new XtensaRunner(elf, netOpts) : new Rv32Runner(elf, netOpts);
  socHost = null;
  devices = [];
  if (attachedDoc) {
    const host = new SocHost(socRunner);
    socHost = host;
    attachDevices((d) => host.add(d.component));
    socRunner.beforeStep = () => host.pump();
  }
}

const api = {
  /** Load firmware HEX from a (same-origin) URL and prepare the AVR emulator (no drawn devices). */
  async load(hexUrl: string): Promise<void> {
    const res = await fetch(hexUrl);
    if (!res.ok) throw new Error(`cannot load firmware: ${res.status}`);
    prepareCircuit(parseIntelHex(await res.text()).bytes);
  },

  /** Attach the drawn circuit so the NEXT load binds its devices to the firmware. Call before load. */
  attachCircuit(doc: CircuitDocument | null, boardId = 'arduino-uno'): void {
    attachedDoc = doc;
    onboardLedPin = boardEntry(boardId)?.onboardLedPin ?? 13;
  },

  /** Load AVR firmware from an Intel-HEX string (binds any attached drawn devices). */
  loadHex(hexText: string): void {
    prepareCircuit(parseIntelHex(hexText).bytes);
  },

  /** Board-aware load: Intel-HEX → AVR (Circuit), ELF → ESP32 SoC (rv32imc / Xtensa by e_machine). */
  loadImage(image: string | Uint8Array, format: ImageFormat): void {
    if (format === 'elf') prepareElf(image as Uint8Array);
    else prepareCircuit(parseIntelHex(image as string).bytes);
  },

  start(): void {
    if (running || !ready()) return;
    running = true;
    state.running = true;
    tick();
  },

  stop(): void {
    running = false;
    state.running = false;
  },

  getState(): SimState {
    return state;
  },

  /**
   * Button press/release on a digital pin. Standard Arduino wiring uses INPUT_PULLUP with the button
   * to GND, so pressed = LOW (0) and released = HIGH (1). Drives the firmware input pin directly.
   */
  setButton(pin: number, pressed: boolean): void {
    if (mode === 'avr') circuit?.runner.setDigitalInput(pin, !pressed);
    else socRunner?.setInput(pin, pressed ? 0 : 1);
  },

  /** Potentiometer/analog raw value on an ADC channel (0..1023 AVR / 0..4095 ESP32). */
  setPot(channel: number, raw: number): void {
    if (mode === 'avr') circuit?.runner.setAnalogVoltage(channel, (raw / 1023) * 5);
    else socRunner?.setAdc(channel, raw);
  },

  /** Live inspector edit of a drawn device (sensor stimulus / actuator setting) while running. */
  setDeviceProp(cid: string, name: string, value: unknown): void {
    const d = devices.find((x) => x.id === cid);
    if (d) applyDeviceProp(d.type, d.component, name, value);
  },

  /**
   * Choose the network tier the NEXT ESP32 load binds to its C3Net (call before loadImage): 'off' (no
   * network), 'fake' (Tier 1 — offline, deterministic), 'real' (Tier 2 — browser fetch + MQTT over a
   * WebSocket broker). Instantiated inside the worker (transports carry methods → not Comlink-serializable;
   * only the tier + config strings cross). Connecting a real broker is async; a failure is reported, not thrown.
   */
  async setNetworkTier(tier: NetworkTier, config: { mqttWsUrl?: string } = {}): Promise<void> {
    netTier = tier;
    const sel = createNetworkTransport(tier, { mqttWsUrl: config.mqttWsUrl });
    net = sel.net;
    mqtt = sel.mqtt;
    blynk = sel.blynk; // connects lazily on the firmware's Blynk.begin (the auth token arrives then)
    netError = null;
    const maybeConnect = mqtt as { connect?: (timeoutMs?: number) => Promise<void> } | null;
    if (maybeConnect?.connect) {
      try {
        await maybeConnect.connect();
      } catch (e) {
        netError = e instanceof Error ? e.message : 'mqtt connect failed';
      }
    }
  },

  /** Snapshot of the live network state for the UI (WiFi phase + tier + any connect error). */
  getNetworkState(): NetworkSnapshot {
    const transport = socRunner?.net?.net as
      | { wifi: { status(): number }; lastError?: string | null }
      | undefined;
    const status = transport?.wifi.status();
    // Surface an HTTP transport failure (CORS block / non-200 like a Blynk invalid-token 400) so a real-tier
    // request that fails is reported, not collapsed into a silent "no data" (audit P0).
    return {
      tier: netTier,
      wifi: wifiPhase(status),
      mqttConnected: mqtt?.connected() ?? false,
      blynkOnline: blynk?.status() === 2,
      error: netError ?? transport?.lastError ?? null,
    };
  },
};

export type SimWorkerApi = typeof api;

Comlink.expose(api);
