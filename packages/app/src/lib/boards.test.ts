import { describe, it, expect } from 'vitest';
import { BOARDS, boardInfo, boardHasWifi, TEMPLATES, DEFAULT_SKETCH } from './boards';

describe('boards data integrity', () => {
  it('exposes exactly 3 boards with the expected ids/names/levels', () => {
    expect(BOARDS).toHaveLength(3);
    expect(BOARDS.map((b) => b.id)).toEqual(['arduino-uno', 'esp32-c3-devkitm', 'esp32-devkit']);
    expect(BOARDS.map((b) => b.name)).toEqual(['Arduino Uno', 'ESP32-C3', 'ESP32 (classic)']);
    expect(BOARDS.map((b) => b.level)).toEqual(['DỄ NHẤT', 'TRUNG BÌNH', 'NÂNG CAO']);
    for (const b of BOARDS) {
      expect(b.sub.length).toBeGreaterThan(0);
      expect(b.blurb.length).toBeGreaterThan(0);
      expect(b.accent.length).toBeGreaterThan(0);
    }
    // ESP32-C3 is flagged work-in-progress (not selectable yet); Uno + classic are ready.
    expect(boardInfo('esp32-c3-devkitm')?.wip).toBe(true);
    expect(boardInfo('arduino-uno')?.wip).toBeFalsy();
    expect(boardInfo('esp32-devkit')?.wip).toBeFalsy();
  });

  it('boardInfo resolves a known board and returns undefined otherwise', () => {
    expect(boardInfo('arduino-uno')?.name).toBe('Arduino Uno');
    expect(boardInfo('esp32-c3-devkitm')?.name).toBe('ESP32-C3');
    expect(boardInfo('nonexistent')).toBeUndefined();
  });

  it('boardHasWifi is true only for the ESP32 family (Uno has no WiFi)', () => {
    expect(boardHasWifi('esp32-c3-devkitm')).toBe(true);
    expect(boardHasWifi('esp32-devkit')).toBe(true);
    expect(boardHasWifi('arduino-uno')).toBe(false);
  });

  it('exposes the starter templates (4 Uno + an ESP32 Blynk IoT) with distinct, well-formed sketches', () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual([
      'blink',
      'button-led',
      'pot-bright',
      'temp-lcd',
      'blynk-iot',
    ]);
    for (const t of TEMPLATES) {
      expect(['led', 'button', 'pot', 'lcd', 'wifi']).toContain(t.swatch);
      expect(t.sketch).toContain('void setup');
      expect(t.sketch).toContain('void loop');
    }
    // the four beginner templates target the Uno; the IoT one targets the ESP32-C3 (WiFi/Blynk). The
    // Start screen hides it while the C3 is work-in-progress, but the data keeps it intact.
    expect(TEMPLATES.filter((t) => t.boardId === 'arduino-uno')).toHaveLength(4);
    const blynk = TEMPLATES.find((t) => t.id === 'blynk-iot')!;
    expect(blynk.boardId).toBe('esp32-c3-devkitm');
    expect(blynk.sketch).toContain('#include <WiFi.h>');
    expect(blynk.sketch).toContain('#include <SparkBlynk.h>');
    expect(blynk.sketch).toContain('BLYNK_WRITE(V0)');
    expect(blynk.sketch).toContain('Blynk.virtualWrite');
    expect(TEMPLATES[0]!.sketch).toBe(DEFAULT_SKETCH);
    expect(TEMPLATES.find((t) => t.id === 'button-led')!.sketch).toContain('INPUT_PULLUP');
    expect(TEMPLATES.find((t) => t.id === 'pot-bright')!.sketch).toContain('analogRead');
    expect(TEMPLATES.find((t) => t.id === 'temp-lcd')!.sketch).toContain('analogRead');
    expect(new Set(TEMPLATES.map((t) => t.sketch)).size).toBe(5); // mutually distinct
  });
});
