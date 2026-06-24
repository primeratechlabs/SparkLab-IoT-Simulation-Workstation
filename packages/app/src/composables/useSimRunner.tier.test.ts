import { describe, it, expect } from 'vitest';
import { resolveNetworkTier } from './useSimRunner';

const BLYNK_REAL = `
#include <WiFi.h>
#include <SparkBlynk.h>
#define BLYNK_AUTH_TOKEN "e-realRealRealToken123456789"
#define LED 2
BLYNK_WRITE(V0){ digitalWrite(LED, param.asInt()?HIGH:LOW); }
void setup(){ Blynk.begin(BLYNK_AUTH_TOKEN); }
void loop(){ Blynk.run(); }
`;
const BLYNK_PLACEHOLDER = BLYNK_REAL.replace('e-realRealRealToken123456789', 'YourBlynkToken');
const NO_BLYNK = `void setup(){ WiFi.begin("x",""); } void loop(){}`;

describe('resolveNetworkTier — Blynk dashboard→device tier routing (root-cause fix)', () => {
  it('auto-routes a Blynk sketch with a REAL token off the offline default to the real Internet', () => {
    const r = resolveNetworkTier(BLYNK_REAL, 'fake');
    expect(r.tier).toBe('real'); // the ONLY tier where the dashboard switch reaches the device
    expect(r.autoSwitched).toBe(true);
    expect(r.notes.join(' ')).toMatch(/Internet thật/i); // discloses the egress
  });

  it('keeps a placeholder-token Blynk sketch offline (nothing real to talk to) + warns to set the token', () => {
    const r = resolveNetworkTier(BLYNK_PLACEHOLDER, 'fake');
    expect(r.tier).toBe('fake');
    expect(r.autoSwitched).toBe(false);
    expect(r.notes.join(' ')).toMatch(/placeholder/i);
  });

  it('does NOT touch the tier for a non-Blynk sketch on the offline default', () => {
    const r = resolveNetworkTier(NO_BLYNK, 'fake');
    expect(r.tier).toBe('fake');
    expect(r.autoSwitched).toBe(false);
    expect(r.notes).toEqual([]);
  });

  it('respects an explicit real-tier choice and warns when the token is still a placeholder', () => {
    expect(resolveNetworkTier(BLYNK_REAL, 'real').notes).toEqual([]); // real token, real tier → nothing to warn
    const r = resolveNetworkTier(BLYNK_PLACEHOLDER, 'real');
    expect(r.tier).toBe('real');
    expect(r.notes.join(' ')).toMatch(/placeholder/i);
  });

  it('leaves the tier untouched when the user already picked real for a real-token Blynk sketch', () => {
    const r = resolveNetworkTier(BLYNK_REAL, 'real');
    expect(r.tier).toBe('real');
    expect(r.autoSwitched).toBe(false);
  });
});
