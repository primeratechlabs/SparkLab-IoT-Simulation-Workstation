/**
 * NORMATIVE INTERFACES — Chromium-Native IoT Simulation Workstation
 *
 * Đây là interface CHUẨN. Mirror file này vào /packages/shared và dùng đúng shape.
 * Nếu thấy thiếu/sai, ĐỀ XUẤT sửa file này trước (hỏi người dùng nếu là thay đổi lớn),
 * rồi cập nhật đồng bộ. KHÔNG tự chế shape song song.
 *
 * Quy ước: thời gian ảo (virtual time) tính bằng nanoseconds (bigint hoặc number an toàn).
 */

// ───────────────────────────── PACKS ─────────────────────────────

export type PackType = 'toolchain' | 'sdk' | 'board' | 'emulator' | 'component';
export type Sha256 = string; // "sha256:..."
export type Ed25519Sig = string; // "ed25519:..."

export interface PackFileRef {
  path: string;
  sha256: Sha256;
}

export interface PackManifestBase {
  packType: PackType;
  name: string;
  version: string; // semver
  files: PackFileRef[];
  signature: Ed25519Sig;
}

export interface ToolchainRequirements {
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  minMemoryGB: number;
  minStorageGB: number;
}

export interface ToolchainPackManifest extends PackManifestBase {
  packType: 'toolchain';
  targetTriples: string[]; // e.g. ["riscv32-esp-elf"], ["avr-atmega328p"], ["xtensa-esp32-elf"]
  variant: 'threaded' | 'singlethread';
  requires: ToolchainRequirements;
}

export interface SdkPackManifest extends PackManifestBase {
  packType: 'sdk';
  target: string; // "esp32c3" | "esp32" | "avr"
  framework: string; // "arduino-esp32" | "arduino-avr"
  arduinoCoreVersion: string;
  espIdfVersion?: string;
  toolchainCompatibility: string[]; // "<name>@<version>"
  sdkconfigHash?: Sha256;
  headersHash: Sha256;
  staticLibrariesHash: Sha256;
  linkerScriptsHash?: Sha256;
  partitionTableHash?: Sha256;
  supportedProfiles: string[]; // ["basic","network-shim"]
  supportedLibrariesSnapshot: string; // arduino library index snapshot id
  pchAvailable: boolean;
}

export interface BoardPackManifest extends PackManifestBase {
  packType: 'board';
  boardId: string; // "esp32-c3-devkitm"
  mcu: string; // "esp32c3"
  architecture: 'avr' | 'riscv32' | 'xtensa';
  pinMap: string; // path to pins.json
  visual: string; // path to board.svg
  defaultSdkPack: string;
  defaultToolchainPack: string;
  supportedPeripherals: PeripheralKind[];
}

export type PeripheralKind = 'gpio' | 'uart' | 'i2c' | 'spi' | 'adc' | 'pwm' | 'wifi';

// ───────────────────────── CAPABILITY ─────────────────────────

export type CapabilityTier = 'S' | 'A' | 'B' | 'C' | 'D';

export interface CapabilityProfile {
  tier: CapabilityTier;
  hardwareConcurrency: number;
  deviceMemoryGB: number | null;
  storageQuotaBytes: number | null;
  storagePersisted: boolean;
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  atomics: boolean;
  opfs: boolean;
  fileSystemAccess: boolean;
  offscreenCanvas: boolean;
  webgpu: boolean;
  wasmSimd: boolean;
  wasmThreads: boolean;
  browser: { brand: string; version: string };
  incognitoRisk: boolean;
  // benchmark results
  wasmInstantiateMsFor50MB: number | null;
  opfsWriteMBps: number | null;
  opfsReadMBps: number | null;
}

/** Kết quả planner quyết định cách chạy cho một project/board. */
export interface ExecutionPlan {
  buildMode:
    | 'preview'
    | 'client-native-wasm-compile'
    | 'client-appliance'
    | 'cached-firmware'
    | 'backend-fallback'; // chỉ khi policy cho phép
  toolchainVariant: 'threaded' | 'singlethread';
  emulatorProfile: string;
  reasons: string[];
}

// ──────────────────────── BUILD / RPC ────────────────────────

export interface CompileRequest {
  command: 'compile';
  sourceKey: Sha256;
  target: string; // target triple/board id
  flags: string[]; // includes reproducible-build flags
  includePaths: string[];
  sdkPack: string; // "<name>@<version>"
}

export interface CompileResult {
  status: 'ok' | 'error';
  objectKey?: Sha256;
  dependencyKey?: Sha256; // .d
  diagnostics: Diagnostic[];
  timeMs: number;
}

export interface Diagnostic {
  severity: 'error' | 'warning' | 'note';
  file: string;
  line: number;
  column?: number;
  message: string;
  /** Lời giải thích thân thiện cho người mới (Stage 7 beginner error translator). */
  friendly?: string;
}

/** Build daemon worker API (qua Comlink). */
export interface BuildDaemon {
  start(): Promise<void>;
  installPack(packId: string): Promise<void>;
  mountSDK(sdkId: string): Promise<void>;
  scanDependencies(projectId: string): Promise<DependencyGraph>;
  compile(req: CompileRequest): Promise<CompileResult>;
  link(targetId: string): Promise<LinkResult>;
  packImage(targetId: string): Promise<ImageResult>;
  runFirmware(targetId: string): Promise<void>;
  stop(): Promise<void>;
}

export interface DependencyGraph {
  units: { id: string; sourceKey: Sha256; includes: string[] }[];
  libraries: ResolvedLibrary[];
}

export interface ResolvedLibrary {
  name: string;
  version: string;
  srcDir: string;
  headers: string[];
  depends: { name: string; constraint?: string }[];
  architectures: string[];
  source: 'registry' | 'github' | 'upload' | 'prebuilt-pack';
}

export interface LinkResult {
  status: 'ok' | 'error';
  elfKey?: Sha256;
  mapKey?: Sha256;
  diagnostics: Diagnostic[];
  timeMs: number;
}

export interface ImageResult {
  status: 'ok' | 'error';
  // AVR
  hexKey?: Sha256;
  // ESP32
  bootloaderKey?: Sha256;
  partitionsKey?: Sha256;
  appKey?: Sha256;
  mergedFlashKey?: Sha256;
  elfKey?: Sha256;
  timeMs: number;
}

/** Đầu vào để tính cache key (xem REFERENCE-SPEC §11). */
export interface ObjectCacheKeyInput {
  compilerId: string;
  compilerFlags: string[];
  targetTriple: string;
  sourceHash: Sha256;
  includedHeaderHashes: Sha256[];
  sdkPackHash: Sha256;
  libraryPackHash: Sha256;
}
export interface FirmwareCacheKeyInput {
  boardId: string;
  mcuTarget: string;
  frameworkVersion: string;
  toolchainPackHash: Sha256;
  sdkPackHash: Sha256;
  objectKeys: Sha256[];
  staticLibraryHashes: Sha256[];
  linkerScriptHash: Sha256;
  partitionTableHash: Sha256;
  imagePackerVersion: string;
  simulationProfileId: string;
}

// ───────────────── PERIPHERAL BRIDGE ABI (virtual time ns) ─────────────────

export type InterceptionLevel = 'api' | 'hal' | 'mmio';

/** Sự kiện từ emulator -> kernel và ngược lại. Discriminated union theo `type`. */
export type BridgeEvent =
  | { t: number; type: 'gpio_write'; pin: number; value: 0 | 1 }
  | { t: number; type: 'gpio_read'; pin: number } // kernel trả về value qua BridgeInput
  | { t: number; type: 'gpio_mode'; pin: number; mode: 'input' | 'output' | 'input_pullup' }
  | { t: number; type: 'uart_tx'; port: number; bytes: number[] }
  | { t: number; type: 'i2c_write'; bus: number; address: string; bytes: number[] }
  | { t: number; type: 'i2c_read'; bus: number; address: string; length: number }
  | { t: number; type: 'spi_transfer'; bus: number; cs: number; mosi: number[] }
  | { t: number; type: 'adc_read'; pin: number } // kernel trả về raw qua BridgeInput
  | { t: number; type: 'pwm_config'; pin: number; freqHz: number; dutyFraction: number };

/** Sự kiện kernel -> emulator (trả lời đọc / kích thích đầu vào). */
export type BridgeInput =
  | { t: number; type: 'gpio_input'; pin: number; value: 0 | 1 }
  | { t: number; type: 'adc_value'; pin: number; raw: number } // raw theo độ phân giải ADC của board
  | { t: number; type: 'uart_rx'; port: number; bytes: number[] }
  | { t: number; type: 'i2c_slave_reply'; bus: number; address: string; bytes: number[] }
  | { t: number; type: 'spi_miso'; bus: number; cs: number; miso: number[] };

/** Binary hot-path frame layout (SharedArrayBuffer ring buffer). */
export interface BinaryEventFrameLayout {
  timestamp: 'uint64';
  event_type: 'uint16';
  bus_or_pin: 'uint16';
  payload_offset: 'uint32';
  payload_length: 'uint32';
}

// ─────────────────────── SIM KERNEL ───────────────────────

export interface SimKernelConfig {
  budgets: CircuitBudgets;
  waveformEnabled: boolean;
  maxEmulatorCyclesPerWallSecond: number; // cap CPU
}

export interface CircuitBudgets {
  maxComponents: number;
  maxNets: number;
  maxEventRate: number;
  maxLogicAnalyzerChannels: number;
  maxWaveformDurationMs: number;
  maxProtocolTxPerSecond: number;
  maxAnalogIslands: number;
  maxSpiceNodes: number;
}

// ───────────────────── COMPONENT CONTRACT ─────────────────────

export type FidelityLevel = 'A' | 'A-' | 'B' | 'B+' | 'C' | 'D' | 'F';
export type ComponentTier =
  | 'builtin-verified'
  | 'verified-community'
  | 'experimental'
  | 'visual-only'
  | 'preview-only';

export interface ComponentPin {
  name: string;
  type:
    | 'power'
    | 'ground'
    | 'digital'
    | 'digital-bidirectional'
    | 'analog'
    | 'i2c-sda'
    | 'i2c-scl'
    | 'spi'
    | 'uart';
}

export interface ComponentManifest {
  componentId: string;
  displayName: string;
  tier: ComponentTier;
  pins: ComponentPin[];
  electrical: { voltageRange: [number, number]; requiresPullup?: boolean };
  protocol?: { type: string; timingSensitive: boolean };
  behavior: {
    runtime: 'wasm' | 'ts';
    entry: string;
    maxMemoryMB: number;
    maxEventRate: number;
  };
  visual: string; // svg path
  fidelity: { level: FidelityLevel; notes: string };
}

/** Host API mà component WASM được phép gọi (capability-limited, KHÔNG DOM/fetch/OPFS-write). */
export interface ComponentHostApi {
  pinRead(pin: string): 0 | 1 | number;
  pinWrite(pin: string, value: 0 | 1 | number): void;
  setTimer(delayNs: number, cb: () => void): number;
  i2cReply(bytes: number[]): void;
  spiReply(bytes: number[]): void;
  uartWrite(bytes: number[]): void;
  framebuffer?(width: number, height: number, rgba: Uint8Array): void;
  log(msg: string): void; // rate-limited
}

// ───────────────────────── NETWORK ─────────────────────────

export type NetworkTier = 'fake-local' | 'browser-mediated' | 'gateway';

/** Frame client<->gateway (tầng 3). L4 per-connection. TLS terminate trong firmware. */
export type GatewayFrame =
  | { t: 'open'; id: number; proto: 'tcp' | 'udp'; host: string; port: number }
  | { t: 'data'; id: number; b: number[] } // payload opaque (có thể là TLS records)
  | { t: 'close'; id: number };

export interface GatewayEgressPolicy {
  allowlist: string[]; // host patterns
  denyPrivateRanges: boolean; // RFC1918/loopback/link-local/metadata
  dnsRebindProtection: boolean;
  maxConnsPerSession: number;
  connRatePerSecond: number;
  bandwidthBytesPerSecond: number;
  sessionWallClockSeconds: number;
}
