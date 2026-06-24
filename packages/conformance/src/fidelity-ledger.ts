/**
 * Stage 7 — programmatic fidelity ledger (invariant I7). The human-readable ledger lives in
 * docs/fidelity-ledger.md; this is the machine-checkable mirror for the standard conformance lab
 * set. Every lab declares a grade + whether it has been CALIBRATED against a hardware rig. Until a
 * `[CI/HUMAN]` HIL rig exists, all labs are uncalibrated — the golden traces guard against
 * regressions, not against divergence from real silicon. Tests assert this honesty.
 */

export type FidelityGrade = 'A' | 'A-' | 'B+' | 'B' | 'B-' | 'C' | 'D' | 'F';

export interface ConformanceLab {
  lab: string;
  grade: FidelityGrade;
  /** True only once measured against real hardware (I7). */
  calibrated: boolean;
  note: string;
}

export const STANDARD_LABS = [
  'blink_timing',
  'i2c_scan',
  'uart_echo',
  'pwm_sweep',
  'servo_signal',
  'dht_read',
  'wifi_mqtt',
] as const;
export type StandardLab = (typeof STANDARD_LABS)[number];

export const FIDELITY_LEDGER: readonly ConformanceLab[] = [
  {
    lab: 'blink_timing',
    grade: 'B+',
    calibrated: false,
    note: 'GPIO toggle ~1 Hz via cycle-derived virtual time (firmware-backed).',
  },
  {
    lab: 'i2c_scan',
    grade: 'B',
    calibrated: false,
    note: 'Address-probe ACK/NACK via the sim-kernel I2C engine; no electrical/clock-stretch timing.',
  },
  {
    lab: 'uart_echo',
    grade: 'B',
    calibrated: false,
    note: 'USART byte echo; baud honoured by the emulator, not hardware-calibrated.',
  },
  {
    lab: 'pwm_sweep',
    grade: 'B',
    calibrated: false,
    note: 'LEDC duty-register sweep; duty value exact, edge timing not hardware-calibrated.',
  },
  {
    lab: 'servo_signal',
    grade: 'B',
    calibrated: false,
    note: 'SG90 angle from HIGH pulse width (1000/1500/2000 µs → 0/90/180°); mechanical response not modelled.',
  },
  {
    lab: 'dht_read',
    grade: 'B-',
    calibrated: false,
    note: 'DHT22 single-wire decode; timing modelled, sensor physics approximate.',
  },
  {
    lab: 'wifi_mqtt',
    grade: 'C',
    calibrated: false,
    note: 'WiFi connect + MQTT pub/sub at the transport level (network-shim); not an RF/stack model.',
  },
];

export function ledgerFor(lab: string): ConformanceLab | undefined {
  return FIDELITY_LEDGER.find((e) => e.lab === lab);
}

/** I7: until a hardware rig calibrates them, every lab must be marked uncalibrated. */
export function allUncalibrated(): boolean {
  return FIDELITY_LEDGER.every((e) => !e.calibrated);
}

/** Every standard lab has a ledger entry (no silent gaps). */
export function ledgerCoversStandardLabs(): boolean {
  return STANDARD_LABS.every((l) => ledgerFor(l) !== undefined);
}

const VALID_GRADES: ReadonlySet<string> = new Set(['A', 'A-', 'B+', 'B', 'B-', 'C', 'D', 'F']);
export function isValidGrade(g: string): g is FidelityGrade {
  return VALID_GRADES.has(g);
}
