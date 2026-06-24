/**
 * Power/ERC presentation model. The electrical rules remain authoritative in
 * sim-kernel; this module combines their findings with optional live rail telemetry
 * and assigns panel-level status without inventing a second ERC rule engine.
 */

import type { ErcFinding, ErcSeverity } from '@sparklab/sim-kernel';

export type PowerStatus = 'ok' | 'warning' | 'error' | 'unknown';
export type PowerErcFinding = ErcFinding;

export interface PowerRailReading {
  id: string;
  label: string;
  voltage: number;
  minVoltage?: number;
  maxVoltage?: number;
  currentMa?: number;
  maxCurrentMa?: number;
}

export interface PowerRailState extends PowerRailReading {
  status: PowerStatus;
  messages: string[];
}

export interface PowerErcSummary {
  status: PowerStatus;
  errors: number;
  warnings: number;
  railErrors: number;
  railWarnings: number;
}

function classifyRail(reading: PowerRailReading): PowerRailState {
  const messages: string[] = [];
  let voltageError = false;
  let currentWarning = false;
  let checked = false;

  if (
    Number.isFinite(reading.voltage) &&
    reading.minVoltage != null &&
    Number.isFinite(reading.minVoltage)
  ) {
    checked = true;
    if (reading.voltage < reading.minVoltage) {
      voltageError = true;
      messages.push(`${reading.label} is below ${reading.minVoltage} V`);
    }
  }
  if (
    Number.isFinite(reading.voltage) &&
    reading.maxVoltage != null &&
    Number.isFinite(reading.maxVoltage)
  ) {
    checked = true;
    if (reading.voltage > reading.maxVoltage) {
      voltageError = true;
      messages.push(`${reading.label} exceeds ${reading.maxVoltage} V`);
    }
  }
  if (
    reading.currentMa != null &&
    reading.maxCurrentMa != null &&
    Number.isFinite(reading.currentMa) &&
    Number.isFinite(reading.maxCurrentMa)
  ) {
    checked = true;
    if (reading.currentMa > reading.maxCurrentMa) {
      currentWarning = true;
      messages.push(
        `${reading.label} draws ${reading.currentMa} mA (limit ${reading.maxCurrentMa} mA)`,
      );
    }
  }

  const status: PowerStatus = voltageError
    ? 'error'
    : currentWarning
      ? 'warning'
      : checked
        ? 'ok'
        : 'unknown';
  return { ...reading, status, messages };
}

export class PowerErcInspector {
  private readonly railMap = new Map<string, PowerRailReading>();
  private erc: ErcFinding[] = [];

  setRail(reading: PowerRailReading): void {
    this.railMap.set(reading.id, { ...reading });
  }

  setRails(readings: PowerRailReading[]): void {
    this.railMap.clear();
    for (const reading of readings) this.setRail(reading);
  }

  setErcFindings(findings: readonly ErcFinding[]): void {
    this.erc = findings.map((finding) => ({ ...finding, refs: [...finding.refs] }));
  }

  rails(): PowerRailState[] {
    return [...this.railMap.values()].map(classifyRail);
  }

  findings(severity?: ErcSeverity): ErcFinding[] {
    return this.erc
      .filter((finding) => severity == null || finding.severity === severity)
      .map((finding) => ({ ...finding, refs: [...finding.refs] }));
  }

  summary(): PowerErcSummary {
    const rails = this.rails();
    const errors = this.erc.filter((finding) => finding.severity === 'error').length;
    const warnings = this.erc.filter((finding) => finding.severity === 'warning').length;
    const railErrors = rails.filter((rail) => rail.status === 'error').length;
    const railWarnings = rails.filter((rail) => rail.status === 'warning').length;
    const hasKnownState = this.erc.length > 0 || rails.some((rail) => rail.status !== 'unknown');
    const status: PowerStatus =
      errors + railErrors > 0
        ? 'error'
        : warnings + railWarnings > 0
          ? 'warning'
          : hasKnownState
            ? 'ok'
            : 'unknown';
    return { status, errors, warnings, railErrors, railWarnings };
  }

  clear(): void {
    this.railMap.clear();
    this.erc = [];
  }
}
