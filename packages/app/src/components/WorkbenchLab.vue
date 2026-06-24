<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import {
  PowerErcInspector,
  ProtocolInspector,
  PwmInspector,
  formatHexBytes,
  formatI2cAddress,
  type I2cTransaction,
  type PowerErcSummary,
  type PowerErcFinding,
  type PowerRailState,
  type PwmChannelState,
  type SpiTransaction,
  type UartChunk,
} from '@sparklab/workbench';
import RenderWorker from '../workers/render.worker?worker';
import { getSim } from '../lib/sim-client.js';

type InspectorTab = 'protocol' | 'pwm' | 'power';

const canvasRef = ref<HTMLCanvasElement | null>(null);
const renderFrames = ref(0);
const fps = ref(0);
const vtimeMs = ref(0);
const running = ref(false);
const error = ref('');
const activeInspector = ref<InspectorTab>('protocol');
const i2cTransactions = ref<I2cTransaction[]>([]);
const spiTransactions = ref<SpiTransaction[]>([]);
const uartChunks = ref<UartChunk[]>([]);
const pwmChannels = ref<PwmChannelState[]>([]);
const powerRails = ref<PowerRailState[]>([]);
const ercFindings = ref<PowerErcFinding[]>([]);
const powerSummary = ref<PowerErcSummary>({
  status: 'unknown',
  errors: 0,
  warnings: 0,
  railErrors: 0,
  railWarnings: 0,
});

let worker: Worker | null = null;
let poll: ReturnType<typeof setInterval> | null = null;
let rafId = 0;
let fpsCount = 0;
let fpsMark = 0;
let serialSnapshot = '';

const protocols = new ProtocolInspector();
const pwm = new PwmInspector();
const power = new PowerErcInspector();

/** Synthetic logic-analyzer channels (so the analyzer shows several waveforms at once). */
function feed(tNs: number, pin13: 0 | 1): void {
  const us = tNs / 1000;
  worker?.postMessage({ type: 'sample', name: 'D13', tNs, value: pin13 });
  worker?.postMessage({ type: 'sample', name: 'PWM9', tNs, value: Math.floor(us / 1000) % 2 }); // ~1kHz-ish
  worker?.postMessage({ type: 'sample', name: 'CLK', tNs, value: Math.floor(us / 250) % 2 }); // faster
}

function refreshInspectors(): void {
  i2cTransactions.value = protocols.i2cTransactions();
  spiTransactions.value = protocols.spiTransactions();
  uartChunks.value = protocols.uartChunks();
  pwmChannels.value = pwm.channels();
  powerRails.value = power.rails();
  ercFindings.value = power.findings();
  powerSummary.value = power.summary();
}

function captureSerial(serial: string, tNs: number): void {
  const appended = serial.startsWith(serialSnapshot) ? serial.slice(serialSnapshot.length) : serial;
  serialSnapshot = serial;
  if (!appended) return;
  protocols.ingest({
    t: tNs,
    type: 'uart_tx',
    port: 0,
    bytes: Array.from(appended, (char) => char.charCodeAt(0) & 0xff),
  });
}

function clearHistory(): void {
  protocols.clear();
  pwm.clear();
  refreshInspectors();
}

function formatTime(tNs: number): string {
  return `${(tNs / 1e6).toFixed(3)} ms`;
}

onMounted(async () => {
  try {
    const canvas = canvasRef.value;
    if (!canvas || typeof canvas.transferControlToOffscreen !== 'function') {
      error.value =
        'OffscreenCanvas is unavailable in this browser. Workbench rendering is disabled.';
      return;
    }
    const offscreen = canvas.transferControlToOffscreen();
    worker = new RenderWorker({ name: 'sparklab-render' });
    worker.onmessage = (e: MessageEvent): void => {
      if ((e.data as { type?: string }).type === 'frames')
        renderFrames.value = (e.data as { frames: number }).frames;
    };
    worker.postMessage({ type: 'init', canvas: offscreen, windowMs: 2000 }, [offscreen]);

    // Run the Blink fixture and stream its D13 (+ synthetic channels) to the renderer.
    await getSim().load('/blink-uno.hex');
    await getSim().start();
    running.value = true;

    poll = setInterval(async () => {
      const s = await getSim().getState();
      vtimeMs.value = Math.round(s.virtualTimeMs);
      feed(s.virtualTimeMs * 1e6, s.pin13);
      captureSerial(s.serial, s.virtualTimeMs * 1e6);
      refreshInspectors();
    }, 30);

    // Main-thread FPS: rendering is off-thread, so this should stay high (gate #4).
    const tick = (now: number): void => {
      fpsCount++;
      if (now - fpsMark >= 1000) {
        fps.value = fpsCount;
        fpsCount = 0;
        fpsMark = now;
      }
      rafId = requestAnimationFrame(tick);
    };
    fpsMark = performance.now();
    rafId = requestAnimationFrame(tick);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    void getSim().stop();
    worker?.terminate();
    worker = null;
  }
});

onUnmounted(() => {
  if (poll) clearInterval(poll);
  if (rafId) cancelAnimationFrame(rafId);
  void getSim().stop();
  running.value = false;
  worker?.postMessage({ type: 'stop' });
  worker?.terminate();
});
</script>

<template>
  <section class="workbench">
    <header class="workbench-heading">
      <div>
        <h3>Workbench</h3>
        <p>Logic analyzer and peripheral inspectors</p>
      </div>
      <button class="clear-button" type="button" @click="clearHistory">Clear history</button>
    </header>

    <div class="analyzer">
      <div class="section-heading">
        <h4>Logic analyzer</h4>
        <span class="live-state">{{ running ? 'Live' : 'Stopped' }}</span>
      </div>
      <p class="mode" data-testid="render-mode">
        Render: OffscreenCanvas worker · Main thread coordinates only (invariant I2)
      </p>
      <p v-if="error" class="banner warn" data-testid="wb-error">{{ error }}</p>
      <canvas
        ref="canvasRef"
        width="640"
        height="96"
        data-testid="logic-canvas"
        style="width: 100%; height: 96px; background: #0b1020; border-radius: 6px"
      />
      <dl class="kv">
        <dt>Worker frames</dt>
        <dd data-testid="render-frames">{{ renderFrames }}</dd>
        <dt>UI FPS (main thread)</dt>
        <dd data-testid="ui-fps">{{ fps }}</dd>
        <dt>Sim virtual time</dt>
        <dd data-testid="wb-vtime">{{ vtimeMs }} ms</dd>
        <dt>Sim</dt>
        <dd data-testid="wb-running">{{ running ? 'running' : 'stopped' }}</dd>
      </dl>
    </div>

    <div class="inspectors">
      <div class="inspector-tabs" role="tablist" aria-label="Workbench inspectors">
        <button
          role="tab"
          :aria-selected="activeInspector === 'protocol'"
          :class="{ active: activeInspector === 'protocol' }"
          data-testid="inspector-tab-protocol"
          @click="activeInspector = 'protocol'"
        >
          I2C / SPI / UART
        </button>
        <button
          role="tab"
          :aria-selected="activeInspector === 'pwm'"
          :class="{ active: activeInspector === 'pwm' }"
          data-testid="inspector-tab-pwm"
          @click="activeInspector = 'pwm'"
        >
          PWM / Servo
        </button>
        <button
          role="tab"
          :aria-selected="activeInspector === 'power'"
          :class="{ active: activeInspector === 'power' }"
          data-testid="inspector-tab-power"
          @click="activeInspector = 'power'"
        >
          Power / ERC
        </button>
      </div>

      <div v-show="activeInspector === 'protocol'" class="inspector-content" role="tabpanel">
        <section class="protocol-section">
          <div class="section-heading">
            <h4>I2C</h4>
            <span>{{ i2cTransactions.length }} transactions</span>
          </div>
          <div v-if="i2cTransactions.length" class="table-scroll">
            <table data-testid="i2c-inspector">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Bus</th>
                  <th>Address</th>
                  <th>Dir</th>
                  <th>Data</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="tx in i2cTransactions" :key="tx.id">
                  <td>{{ formatTime(tx.tNs) }}</td>
                  <td>{{ tx.bus }}</td>
                  <td>{{ formatI2cAddress(tx.address) }}</td>
                  <td>{{ tx.direction }}</td>
                  <td class="bytes">
                    {{ formatHexBytes(tx.direction === 'read' ? tx.reply : tx.bytes) }}
                  </td>
                  <td>
                    <span class="status" :class="tx.status">{{ tx.status }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="empty">No I2C transactions captured.</p>
        </section>

        <section class="protocol-section">
          <div class="section-heading">
            <h4>SPI</h4>
            <span>{{ spiTransactions.length }} transfers</span>
          </div>
          <div v-if="spiTransactions.length" class="table-scroll">
            <table data-testid="spi-inspector">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Bus</th>
                  <th>CS</th>
                  <th>MOSI</th>
                  <th>MISO</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="tx in spiTransactions" :key="tx.id">
                  <td>{{ formatTime(tx.tNs) }}</td>
                  <td>{{ tx.bus }}</td>
                  <td>{{ tx.cs }}</td>
                  <td class="bytes">{{ formatHexBytes(tx.mosi) }}</td>
                  <td class="bytes">{{ formatHexBytes(tx.miso) }}</td>
                  <td>
                    <span class="status" :class="tx.status">{{ tx.status }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="empty">No SPI transfers captured.</p>
        </section>

        <section class="protocol-section">
          <div class="section-heading">
            <h4>UART</h4>
            <span>{{ uartChunks.length }} chunks</span>
          </div>
          <div v-if="uartChunks.length" class="table-scroll">
            <table data-testid="uart-inspector">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Port</th>
                  <th>Dir</th>
                  <th>Text</th>
                  <th>Bytes</th>
                  <th>EOL</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="chunk in uartChunks" :key="chunk.id">
                  <td>{{ formatTime(chunk.tNs) }}</td>
                  <td>{{ chunk.port }}</td>
                  <td>{{ chunk.direction.toUpperCase() }}</td>
                  <td class="serial-text">{{ chunk.text }}</td>
                  <td class="bytes">{{ formatHexBytes(chunk.bytes) }}</td>
                  <td>{{ chunk.lineEnding }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="empty">No UART traffic captured.</p>
        </section>
      </div>

      <div v-show="activeInspector === 'pwm'" class="inspector-content" role="tabpanel">
        <div class="section-heading">
          <h4>PWM channels</h4>
          <span>{{ pwmChannels.length }} active</span>
        </div>
        <div v-if="pwmChannels.length" class="table-scroll">
          <table data-testid="pwm-inspector">
            <thead>
              <tr>
                <th>Pin</th>
                <th>Frequency</th>
                <th>Duty</th>
                <th>High pulse</th>
                <th>Period</th>
                <th>Servo</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="channel in pwmChannels" :key="channel.pin">
                <td>D{{ channel.pin }}</td>
                <td>{{ channel.frequencyHz.toFixed(2) }} Hz</td>
                <td>{{ channel.dutyPercent.toFixed(2) }}%</td>
                <td>{{ channel.highUs.toFixed(1) }} µs</td>
                <td>{{ channel.periodUs.toFixed(1) }} µs</td>
                <td>
                  {{ channel.servoAngleDeg == null ? '—' : `${channel.servoAngleDeg.toFixed(1)}°` }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="empty">No PWM configuration captured.</p>
      </div>

      <div v-show="activeInspector === 'power'" class="inspector-content" role="tabpanel">
        <div class="power-summary" :class="powerSummary.status" data-testid="power-summary">
          <strong>{{ powerSummary.status.toUpperCase() }}</strong>
          <span>{{ powerSummary.errors + powerSummary.railErrors }} errors</span>
          <span>{{ powerSummary.warnings + powerSummary.railWarnings }} warnings</span>
        </div>
        <div v-if="powerRails.length" class="table-scroll">
          <table data-testid="power-inspector">
            <thead>
              <tr>
                <th>Rail</th>
                <th>Voltage</th>
                <th>Current</th>
                <th>Status</th>
                <th>Finding</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="rail in powerRails" :key="rail.id">
                <td>{{ rail.label }}</td>
                <td>{{ rail.voltage.toFixed(3) }} V</td>
                <td>{{ rail.currentMa == null ? '—' : `${rail.currentMa.toFixed(1)} mA` }}</td>
                <td>
                  <span class="status" :class="rail.status">{{ rail.status }}</span>
                </td>
                <td>{{ rail.messages.join('; ') || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <section v-if="ercFindings.length" class="erc-findings" data-testid="erc-findings">
          <div class="section-heading">
            <h4>Electrical rule checker</h4>
            <span>{{ ercFindings.length }} findings</span>
          </div>
          <ul>
            <li v-for="finding in ercFindings" :key="`${finding.rule}:${finding.refs.join(':')}`">
              <span class="status" :class="finding.severity">{{ finding.severity }}</span>
              <span>{{ finding.message }}</span>
              <code>{{ finding.refs.join(', ') }}</code>
            </li>
          </ul>
        </section>
        <p v-if="!powerRails.length && !ercFindings.length" class="empty">
          No power telemetry or ERC findings available.
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.workbench {
  margin-top: 1rem;
  border: 1px solid #d7dde5;
  border-radius: 8px;
  overflow: hidden;
}
.workbench-heading,
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
.workbench-heading {
  padding: 0.85rem 1rem;
  border-bottom: 1px solid #d7dde5;
}
.workbench-heading h3,
.workbench-heading p,
.section-heading h4 {
  margin: 0;
}
.workbench-heading p,
.section-heading span {
  color: #64748b;
  font-size: 0.78rem;
}
.clear-button {
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  background: transparent;
  padding: 0.35rem 0.65rem;
  cursor: pointer;
}
.analyzer {
  padding: 0.85rem 1rem 1rem;
}
.live-state {
  color: #166534 !important;
  font-weight: 700;
  text-transform: uppercase;
}
.mode {
  font-size: 0.85rem;
  color: #115c2e;
  margin: 0.2rem 0 0.6rem;
}
.kv {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.2rem 1rem;
  margin: 0.6rem 0 0;
  font-size: 0.9rem;
}
.kv dt {
  color: #64748b;
}
.kv dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.inspectors {
  border-top: 1px solid #d7dde5;
}
.inspector-tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid #d7dde5;
  overflow-x: auto;
}
.inspector-tabs button {
  border: 0;
  border-right: 1px solid #d7dde5;
  border-radius: 0;
  background: transparent;
  padding: 0.65rem 0.85rem;
  white-space: nowrap;
  cursor: pointer;
}
.inspector-tabs button.active {
  color: #fff;
  background: #1d4ed8;
}
.inspector-content {
  padding: 0.85rem 1rem 1rem;
}
.protocol-section + .protocol-section {
  margin-top: 1.15rem;
  padding-top: 1rem;
  border-top: 1px solid #e2e8f0;
}
.table-scroll {
  margin-top: 0.45rem;
  overflow-x: auto;
}
table {
  min-width: 620px;
}
th,
td {
  white-space: nowrap;
}
.bytes,
.serial-text {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.serial-text {
  max-width: 18rem;
  overflow: hidden;
  text-overflow: ellipsis;
}
.empty {
  margin: 0.7rem 0 0;
  color: #64748b;
  font-size: 0.85rem;
}
.status {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
}
.status.complete,
.status.ok {
  color: #166534;
}
.status.pending,
.status.warning {
  color: #a16207;
}
.status.partial,
.status.error {
  color: #b91c1c;
}
.power-summary {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.55rem 0;
  border-bottom: 1px solid #e2e8f0;
  font-size: 0.82rem;
}
.power-summary.error strong {
  color: #b91c1c;
}
.power-summary.warning strong {
  color: #a16207;
}
.power-summary.ok strong {
  color: #166534;
}
.power-summary.unknown strong {
  color: #64748b;
}
.erc-findings {
  margin-top: 1rem;
  padding-top: 0.85rem;
  border-top: 1px solid #e2e8f0;
}
.erc-findings ul {
  list-style: none;
  padding: 0;
  margin: 0.55rem 0 0;
}
.erc-findings li {
  display: grid;
  grid-template-columns: 4.5rem minmax(12rem, 1fr) auto;
  gap: 0.75rem;
  align-items: baseline;
  padding: 0.45rem 0;
  border-bottom: 1px solid #eef2f7;
  font-size: 0.82rem;
}
.erc-findings code {
  color: #64748b;
}
@media (max-width: 640px) {
  .workbench-heading {
    align-items: flex-start;
  }
  .inspector-content,
  .analyzer {
    padding-left: 0.75rem;
    padding-right: 0.75rem;
  }
  .erc-findings li {
    grid-template-columns: 4.5rem 1fr;
  }
  .erc-findings code {
    grid-column: 2;
  }
}
</style>
