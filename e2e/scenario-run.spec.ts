import { test, expect } from '@playwright/test';

/**
 * In-browser re-verification of the ESP32 breadboard scenario after the µs-clock fix: the STANDARD sketch
 * (map/pulseIn/Serial.printf) compiles + runs, and the HC-SR04 now reads a real distance (≈20 cm) instead
 * of 0. Captures the serial promptly (the heavy Xtensa emulation can later exhaust the headless renderer).
 */
const SKETCH = `#include <Arduino.h>
const int LED1=2, LED2=4, LED3=5, BTN1=12, BTN2=14, LDR=34, TRIG=25, ECHO=26, SERVO1=18, SERVO2=19;
bool ledOn=false, mode=false;
int servoDuty(int a){ int us=map(constrain(a,0,180),0,180,500,2500); return (int)((long)us*65535L/20000L); }
long readDistanceCm(){
  digitalWrite(TRIG,LOW); delayMicroseconds(2);
  digitalWrite(TRIG,HIGH); delayMicroseconds(10); digitalWrite(TRIG,LOW);
  long us = pulseIn(ECHO, HIGH, 30000);
  return us/58;
}
void setup(){
  Serial.begin(115200);
  pinMode(LED1,OUTPUT); pinMode(LED2,OUTPUT); pinMode(LED3,OUTPUT);
  pinMode(BTN1,INPUT_PULLUP); pinMode(BTN2,INPUT_PULLUP);
  pinMode(TRIG,OUTPUT); pinMode(ECHO,INPUT);
  ledcAttach(SERVO1,50,16); ledcAttach(SERVO2,50,16);
}
void loop(){
  int light=analogRead(LDR);
  long d=readDistanceCm();
  digitalWrite(LED3, (d>0&&d<15)?HIGH:LOW);
  ledcWrite(SERVO1, servoDuty(map(constrain(d,2,60),2,60,0,180)));
  ledcWrite(SERVO2, servoDuty(map(light,0,4095,0,180)));
  Serial.printf("light=%d dist=%ld\\n", light, d);
  delay(50);
}
`;
const placed = [
  { cid: 'hcsr04-1', type: 'hcsr04', tag: 'wokwi-hc-sr04', x: 460, y: 90, rot: 0, flip: false, props: { distanceCm: 20 } },
  { cid: 'ldr-2', type: 'ldr', tag: 'wokwi-photoresistor-sensor', x: 460, y: 200, rot: 0, flip: false, props: { rFixedOhms: 10000 } },
];
const B = '__board__';
const wires = [
  { id: 'w1', from: { cid: 'hcsr04-1', pin: 'TRIG' }, to: { cid: B, pin: 'D25' }, points: [] },
  { id: 'w2', from: { cid: 'hcsr04-1', pin: 'ECHO' }, to: { cid: B, pin: 'D26' }, points: [] },
  { id: 'w3', from: { cid: 'hcsr04-1', pin: 'VCC' }, to: { cid: B, pin: 'VIN' }, points: [] },
  { id: 'w4', from: { cid: 'hcsr04-1', pin: 'GND' }, to: { cid: B, pin: 'GND.1' }, points: [] },
  { id: 'w5', from: { cid: 'ldr-2', pin: 'AO' }, to: { cid: B, pin: 'D34' }, points: [] },
  { id: 'w6', from: { cid: 'ldr-2', pin: 'VCC' }, to: { cid: B, pin: '3V3' }, points: [] },
  { id: 'w7', from: { cid: 'ldr-2', pin: 'GND' }, to: { cid: B, pin: 'GND.2' }, points: [] },
];
const PROJECT = {
  version: 2,
  boardId: 'esp32-devkit',
  name: 'esp32_hcsr04_check',
  sketch: SKETCH,
  canvas: { placed, wires, boardPos: { x: 40, y: 60 }, boardRot: 0 },
};

test('HC-SR04 reads a real distance (~20 cm, not 0) in the browser after the µs-clock fix', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto('/');
  await page.evaluate((p) => localStorage.setItem('sparklab:project', JSON.stringify(p)), PROJECT);
  await page.reload();
  await expect(page.locator('wokwi-esp32-devkit-v1')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('ws-run').click();
  await expect
    .poll(() => page.getByTestId('ws-status').getAttribute('data-status'), { timeout: 170_000, intervals: [400] })
    .toMatch(/running|error/);
  const status = await page.getByTestId('ws-status').getAttribute('data-status');
  expect(status, 'must compile + run').toBe('running');

  // poll the serial for a couple of seconds until a distance reading appears; grab it before any crash
  let dist = -1;
  for (let i = 0; i < 20; i++) {
    const s = (await page.getByTestId('serial-log').textContent().catch(() => '')) ?? '';
    const m = [...s.matchAll(/dist=(-?\d+)(?=\D)/g)];
    if (m.length) {
      dist = Number(m[m.length - 1]![1]);
      if (dist > 0) break;
    }
    await page.waitForTimeout(300).catch(() => undefined);
  }
  console.log(`SCENARIO in-browser dist=${dist}`);
  expect(dist, 'HC-SR04 must read ~20 cm (was 0 before the fix)').toBeGreaterThanOrEqual(18);
  expect(dist).toBeLessThanOrEqual(22);
});
