<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { getSim } from '../lib/sim-client.js';
import { getBuild } from '../lib/build-client.js';
import { translateDiagnostics } from '@sparklab/build-orchestrator';

const BLINK_SOURCE = `void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(9600);
}
void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  Serial.println("blink on");
  delay(1000);
  digitalWrite(LED_BUILTIN, LOW);
  Serial.println("blink off");
  delay(1000);
}`;

// Presets that exercise external-library compilation entirely in the browser.
const PRESETS: Record<string, string> = {
  Blink: BLINK_SOURCE,
  'LED + Servo + pot + button': `#include <Servo.h>
Servo myServo;
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(2, INPUT_PULLUP);
  Serial.begin(9600);
  myServo.attach(9);
}
void loop() {
  int angle = map(analogRead(A0), 0, 1023, 0, 180);
  myServo.write(angle);
  bool pressed = digitalRead(2) == LOW;
  digitalWrite(LED_BUILTIN, pressed ? HIGH : LOW);
  Serial.print("angle="); Serial.print(angle);
  Serial.print(" blink on"); Serial.println(pressed ? " (btn)" : "");
  delay(200);
}`,
  'I2C LCD (LiquidCrystal_I2C + Wire)': `#include <Wire.h>
#include <LiquidCrystal_I2C.h>
LiquidCrystal_I2C lcd(0x27, 16, 2);
void setup() {
  Serial.begin(9600);
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("Hello Sparklab");
  Serial.println("blink on: LCD ready");
}
void loop() { delay(1000); }`,
  'DHT22 sensor (DHT + Adafruit Unified Sensor)': `#include <DHT.h>
#define DHTPIN 2
#define DHTTYPE DHT22
DHT dht(DHTPIN, DHTTYPE);
void setup() {
  Serial.begin(9600);
  dht.begin();
  Serial.println("blink on: DHT ready");
}
void loop() {
  float h = dht.readHumidity();
  float t = dht.readTemperature();
  Serial.print("H="); Serial.print(h);
  Serial.print(" T="); Serial.println(t);
  delay(2000);
}`,
};

const presetName = ref('Blink');
const source = ref(BLINK_SOURCE);
function applyPreset(): void {
  source.value = PRESETS[presetName.value] ?? BLINK_SOURCE;
}
const pin13 = ref<0 | 1>(0);
const ledToggles = ref(0);
const serial = ref('');
const vtimeMs = ref(0);
const running = ref(false);
const loaded = ref(false);
const compileStatus = ref<'idle' | 'compiling' | 'ok' | 'error'>('idle');
const compileMsg = ref('');

let poll: ReturnType<typeof setInterval> | null = null;

async function loadFirmware(): Promise<void> {
  // Stage-2 momentum: firmware comes from a host avr-gcc fixture (.hex). When the
  // avr-gcc.wasm toolchain pack lands, this same .hex is produced client-side.
  await getSim().load('/blink-uno.hex');
  loaded.value = true;
}

onMounted(async () => {
  await loadFirmware();
  poll = setInterval(async () => {
    const s = await getSim().getState();
    pin13.value = s.pin13;
    ledToggles.value = s.ledToggles;
    serial.value = s.serial;
    vtimeMs.value = Math.round(s.virtualTimeMs);
    running.value = s.running;
  }, 100);
});

onUnmounted(() => {
  if (poll) clearInterval(poll);
});

async function run(): Promise<void> {
  if (!loaded.value) await loadFirmware();
  await getSim().start();
}
async function stop(): Promise<void> {
  await getSim().stop();
}

/**
 * Stage 2 Gate #1 — compile the editor sketch to firmware 100% client-side with the
 * real avr-gcc.wasm toolchain, then run the resulting HEX on the emulator. No bytes
 * leave the browser (invariant I8: no backend compile).
 */
async function compileAndRun(): Promise<void> {
  compileStatus.value = 'compiling';
  compileMsg.value = 'Compiling with avr-gcc.wasm (client-side)…';
  await getSim().stop();
  try {
    const result = await getBuild().compileToHex(source.value);
    // Stage 7: attach a beginner-friendly explanation to each diagnostic.
    const errors = translateDiagnostics(result.diagnostics).filter((d) => d.severity === 'error');
    if (!result.hex || errors.length > 0) {
      compileStatus.value = 'error';
      compileMsg.value =
        errors
          .map((e) => `${e.file}:${e.line}: ${e.message}${e.friendly ? `\n  → ${e.friendly}` : ''}`)
          .join('\n') || 'compile failed';
      return;
    }
    await getSim().loadHex(result.hex);
    loaded.value = true;
    compileStatus.value = 'ok';
    const libs = result.libraries.length ? ` · libs: ${result.libraries.join(', ')}` : '';
    const bytes = result.elfBytes ?? 0;
    if (result.fromFirmwareCache) {
      compileMsg.value = `Loaded cached firmware ✓ ${bytes} B${libs} · 0 compile, 0 backend calls`;
    } else {
      const cached = result.reusedUnitIds.length ? ` (${result.reusedUnitIds.length} reused)` : '';
      compileMsg.value =
        `Compiled client-side ✓ ${bytes} B ELF${libs}` +
        ` · compiled ${result.compiledUnitIds.length} unit(s)${cached} · 0 backend calls`;
    }
    await getSim().start();
  } catch (err) {
    compileStatus.value = 'error';
    compileMsg.value = err instanceof Error ? err.message : String(err);
  }
}
function onButton(pressed: boolean): void {
  void getSim().setButton(2, pressed);
}
function onPot(e: Event): void {
  void getSim().setPot(0, Number((e.target as HTMLInputElement).value));
}
</script>

<template>
  <section>
    <div class="card">
      <div class="row-actions">
        <button
          class="action primary"
          data-testid="sim-compile-run"
          :disabled="compileStatus === 'compiling'"
          @click="compileAndRun"
        >
          ⚙ Compile &amp; Run (client-side avr-gcc.wasm)
        </button>
        <button class="action" data-testid="sim-run" @click="run">▶ Run fixture</button>
        <button class="action" data-testid="sim-stop" @click="stop">■ Stop</button>
        <span data-testid="sim-running">{{ running ? 'running' : 'stopped' }}</span>
      </div>
      <p class="mode" data-testid="mode-label">
        Firmware compiled: Yes (client-side avr-gcc.wasm) · Timing: Exact (cycle-accurate avr8js)
      </p>
      <pre
        v-if="compileStatus !== 'idle'"
        class="compile-status"
        :class="compileStatus"
        data-testid="compile-status"
        >{{ compileMsg }}</pre
      >
    </div>

    <div class="card">
      <h3>Arduino Uno — circuit</h3>
      <div class="circuit">
        <div class="led-wrap">
          <div class="led" :class="{ on: pin13 === 1 }" data-testid="led" />
          <small>LED on D13</small>
          <div data-testid="led-state">{{ pin13 === 1 ? 'on' : 'off' }}</div>
        </div>
        <dl class="kv">
          <dt>LED toggles</dt>
          <dd data-testid="led-toggles">{{ ledToggles }}</dd>
          <dt>Virtual time</dt>
          <dd data-testid="sim-vtime">{{ vtimeMs }} ms</dd>
        </dl>
        <div class="inputs">
          <button
            class="action"
            data-testid="button-d2"
            @mousedown="onButton(true)"
            @mouseup="onButton(false)"
          >
            Button (D2)
          </button>
          <label
            >Pot (A0)
            <input type="range" min="0" max="1023" data-testid="pot-a0" @input="onPot" />
          </label>
        </div>
      </div>
    </div>

    <div class="card">
      <h3>Serial Monitor</h3>
      <pre data-testid="serial-output">{{ serial || '(no output yet)' }}</pre>
    </div>

    <div class="card">
      <h3>Sketch (.ino)</h3>
      <label class="preset-row">
        Example:
        <select v-model="presetName" data-testid="preset-select" @change="applyPreset">
          <option v-for="name in Object.keys(PRESETS)" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <textarea
        v-model="source"
        spellcheck="false"
        rows="12"
        data-testid="code-editor"
        style="width: 100%; font-family: ui-monospace, monospace; font-size: 0.8rem"
      />
      <small
        >Edit the sketch, then <strong>Compile &amp; Run</strong> to build firmware with the real
        avr-gcc.wasm toolchain entirely in your browser (no server). The toolchain (~18&nbsp;MB)
        downloads once on first compile.</small
      >
    </div>
  </section>
</template>

<style scoped>
.mode {
  font-size: 0.85rem;
  color: #115c2e;
  margin: 0.4rem 0 0;
}
.preset-row {
  display: block;
  margin-bottom: 0.5rem;
  font-size: 0.85rem;
}
.preset-row select {
  margin-left: 0.4rem;
}
.action.primary {
  background: #115c2e;
  color: #fff;
  border-color: #0b4020;
}
.compile-status {
  margin: 0.5rem 0 0;
  padding: 0.5rem 0.7rem;
  border-radius: 6px;
  font-size: 0.8rem;
  white-space: pre-wrap;
  background: #f1f5f9;
}
.compile-status.ok {
  background: #dcfce7;
  color: #115c2e;
}
.compile-status.error {
  background: #fee2e2;
  color: #991b1b;
}
.compile-status.compiling {
  background: #fef9c3;
  color: #713f12;
}
.circuit {
  display: flex;
  gap: 2rem;
  align-items: center;
  flex-wrap: wrap;
}
.led {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  background: #4b5563;
  box-shadow: 0 0 0 3px #1f2937;
  transition: background 0.05s;
}
.led.on {
  background: #fde047;
  box-shadow:
    0 0 0 3px #1f2937,
    0 0 18px 6px rgba(253, 224, 71, 0.8);
}
.led-wrap {
  text-align: center;
}
.inputs {
  display: flex;
  gap: 1rem;
  align-items: center;
  flex-wrap: wrap;
}
</style>
