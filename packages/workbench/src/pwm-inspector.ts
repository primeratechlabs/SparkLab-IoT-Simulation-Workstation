/**
 * PWM and servo presentation model. Values are derived from the bridge's virtual-time
 * PWM configuration, never animation-frame timing, so fast-forward and throttling do
 * not change the displayed pulse geometry.
 */

import type { BridgeEvent } from '@sparklab/shared';

export interface PwmChannelState {
  tNs: number;
  pin: number;
  frequencyHz: number;
  periodUs: number;
  highUs: number;
  dutyFraction: number;
  dutyPercent: number;
  servoAngleDeg: number | null;
  valid: boolean;
  warning?: string;
}

export interface PwmInspectorOptions {
  maxHistoryPerPin?: number;
}

const SERVO_MIN_HZ = 40;
const SERVO_MAX_HZ = 60;

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, finiteOrZero(value)));
}

export function servoAngleFromPulse(highUs: number): number {
  const angle = ((finiteOrZero(highUs) - 1000) / 1000) * 180;
  return Math.max(0, Math.min(180, angle));
}

export class PwmInspector {
  private readonly maxHistory: number;
  private readonly byPin = new Map<number, PwmChannelState[]>();

  constructor(options: PwmInspectorOptions = {}) {
    const requested = options.maxHistoryPerPin;
    this.maxHistory =
      Number.isFinite(requested) && requested! > 0 ? Math.max(1, Math.floor(requested!)) : 256;
  }

  ingest(event: BridgeEvent): void {
    if (event.type !== 'pwm_config') return;

    const validFrequency = Number.isFinite(event.freqHz) && event.freqHz > 0;
    const validDuty = Number.isFinite(event.dutyFraction);
    const frequencyHz = validFrequency ? event.freqHz : 0;
    const dutyFraction = clamp01(event.dutyFraction);
    const periodUs = validFrequency ? 1_000_000 / frequencyHz : 0;
    const highUs = periodUs * dutyFraction;
    const servoAngleDeg =
      validFrequency && frequencyHz >= SERVO_MIN_HZ && frequencyHz <= SERVO_MAX_HZ
        ? servoAngleFromPulse(highUs)
        : null;

    let warning: string | undefined;
    if (!validFrequency) warning = 'PWM frequency must be a finite value greater than zero';
    else if (!Number.isFinite(event.dutyFraction)) warning = 'PWM duty cycle is not finite';
    else if (event.dutyFraction < 0 || event.dutyFraction > 1)
      warning = 'PWM duty cycle was clamped to 0..1';

    const state: PwmChannelState = {
      tNs: Number.isFinite(event.t) ? Math.max(0, Math.round(event.t)) : 0,
      pin: event.pin,
      frequencyHz,
      periodUs,
      highUs,
      dutyFraction,
      dutyPercent: dutyFraction * 100,
      servoAngleDeg,
      valid: validFrequency && validDuty,
      ...(warning ? { warning } : {}),
    };
    const history = this.byPin.get(event.pin) ?? [];
    history.push(state);
    if (history.length > this.maxHistory) history.splice(0, history.length - this.maxHistory);
    this.byPin.set(event.pin, history);
  }

  channel(pin: number): PwmChannelState | undefined {
    const history = this.byPin.get(pin);
    const latest = history?.at(-1);
    return latest ? { ...latest } : undefined;
  }

  channels(): PwmChannelState[] {
    return [...this.byPin.keys()]
      .sort((a, b) => a - b)
      .flatMap((pin) => {
        const state = this.channel(pin);
        return state ? [state] : [];
      });
  }

  history(pin: number): PwmChannelState[] {
    return (this.byPin.get(pin) ?? []).map((entry) => ({ ...entry }));
  }

  clear(): void {
    this.byPin.clear();
  }
}
