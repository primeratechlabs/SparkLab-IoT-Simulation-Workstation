<script setup lang="ts">
/**
 * Stage 6 — Network Lab. Visualises the WiFi + sensors + MQTT + HTTP vertical interactively,
 * driving the SAME @sparklab/network-shim transports the firmware HAL delegates to (so what you
 * see is the real network layer, not a mock). A simulated multi-sensor device publishes its
 * readings and reacts to a relay command — over a Tier-1 fake broker (deterministic, no network)
 * or a real public MQTT broker over WebSocket (Tier 2, broker URL from .env). The HTTP panel
 * sends a request the same way (fake echo, or a real fetch). backend = 0 (I8).
 */
import { onUnmounted, ref, computed } from 'vue';
import {
  resolveNetworkConfig,
  WiFiSim,
  FakeMqttBroker,
  Tier2Mqtt,
  WL_CONNECTED,
  type MqttTransport,
} from '@sparklab/network-shim';

const config = resolveNetworkConfig(import.meta.env as Record<string, string | undefined>);

type Tier = 'fake' | 'real';
const tier = ref<Tier>('fake');
const wifiStatus = ref<'idle' | 'connecting' | 'connected'>('idle');

// three sensors (the "primary" one keeps the testid `net-sensor` for continuity)
const sensor = ref(2750); // temperature
const humidity = ref(1800);
const light = ref(3200);
const relay = ref(false);
const auto = ref(false);
const error = ref<string | null>(null);
const published = ref<string[]>([]);
const received = ref<string[]>([]);

// HTTP panel
const httpMethod = ref<'GET' | 'POST'>('GET');
const httpUrl = ref('http://iot.local/api');
const httpBody = ref('hello=world');
const httpResult = ref('');

const deviceId = `dev-${Math.random().toString(16).slice(2, 8)}`;
const topic = (name: string): string => `sparklab/${deviceId}/${name}`;
const topicCmd = topic('cmd');
const brokerLabel = computed(() =>
  tier.value === 'fake' ? 'Fake broker (Tier 1 — no network)' : config.mqttWsUrl,
);

let wifi = new WiFiSim(3);
let broker: MqttTransport | null = null;
let tier2: Tier2Mqtt | null = null;
let pollTimer: number | undefined;
let pubTimer: number | undefined;

function logTo(buf: typeof published, line: string): void {
  buf.value.unshift(`${new Date().toLocaleTimeString()}  ${line}`);
  if (buf.value.length > 40) buf.value.pop();
}

async function connect(): Promise<void> {
  if (wifiStatus.value !== 'idle') return;
  error.value = null;
  wifiStatus.value = 'connecting';
  wifi = new WiFiSim(3);
  wifi.begin('sparklab');
  // default the HTTP target sensibly per tier. The real-tier default must be a CORS-enabled endpoint
  // reachable from the browser (postman-echo.com blocks cross-origin → "Failed to fetch"); httpbin.org
  // returns permissive CORS headers and is the verified default for the Tier-2 browser fetch path.
  httpUrl.value = tier.value === 'fake' ? 'http://iot.local/api' : 'https://httpbin.org/get';
  try {
    if (tier.value === 'fake') {
      broker = new FakeMqttBroker();
    } else {
      tier2 = new Tier2Mqtt({ url: config.mqttWsUrl, clientId: deviceId });
      await tier2.connect(8000);
      broker = tier2;
    }
  } catch (e) {
    error.value = `MQTT connect failed: ${(e as Error).message}`;
    wifiStatus.value = 'idle';
    return;
  }
  await new Promise<void>((resolve) => {
    pollTimer = window.setInterval(() => {
      wifi.poll();
      if (wifi.status() === WL_CONNECTED) {
        window.clearInterval(pollTimer);
        resolve();
      }
    }, 120);
  });
  wifiStatus.value = 'connected';
  broker.subscribe(topicCmd, (m) => {
    relay.value = m.payload.trim() === '1' || m.payload.toUpperCase().includes('ON');
    logTo(received, `cmd → ${m.payload}  (relay ${relay.value ? 'ON' : 'off'})`);
  });
  broker.subscribe(topic('temp'), (m) =>
    logTo(received, `✓ broker echoed telemetry = ${m.payload}`),
  );
  logTo(received, `subscribed ${topicCmd}`);
}

function publish(): void {
  if (!broker || wifi.status() !== WL_CONNECTED) return;
  void broker.publish(topic('temp'), String(sensor.value));
  void broker.publish(topic('humidity'), String(humidity.value));
  void broker.publish(topic('light'), String(light.value));
  logTo(
    published,
    `→ temp = ${sensor.value}, humidity = ${humidity.value}, light = ${light.value}`,
  );
}

function command(on: boolean): void {
  if (!broker) return;
  if (tier.value === 'fake') (broker as FakeMqttBroker).inject(topicCmd, on ? '1' : '0');
  else void (broker as Tier2Mqtt).publish(topicCmd, on ? '1' : '0');
}

function toggleAuto(): void {
  auto.value = !auto.value;
  if (auto.value) pubTimer = window.setInterval(publish, 1500);
  else window.clearInterval(pubTimer);
}

async function sendHttp(): Promise<void> {
  httpResult.value = '…';
  if (tier.value === 'fake') {
    // deterministic fake echo (no network) — demonstrates request/response shape
    const body = httpMethod.value === 'POST' ? httpBody.value : '';
    httpResult.value = `200  echo ${httpMethod.value} ${httpUrl.value}${body ? ` body=${body}` : ''}`;
    logTo(received, `HTTP ${httpMethod.value} ${httpUrl.value} → 200 (fake)`);
    return;
  }
  try {
    const r = await fetch(httpUrl.value, {
      method: httpMethod.value,
      body: httpMethod.value === 'GET' ? undefined : httpBody.value,
    });
    const text = await r.text();
    httpResult.value = `${r.status}  ${text.slice(0, 240)}`;
    logTo(received, `HTTP ${httpMethod.value} ${httpUrl.value} → ${r.status}`);
  } catch (e) {
    httpResult.value = `error: ${(e as Error).message}`;
  }
}

function reset(): void {
  window.clearInterval(pollTimer);
  window.clearInterval(pubTimer);
  tier2?.disconnect();
  tier2 = null;
  broker = null;
  wifiStatus.value = 'idle';
  relay.value = false;
  auto.value = false;
  published.value = [];
  received.value = [];
  error.value = null;
  httpResult.value = '';
}

onUnmounted(reset);
</script>

<template>
  <section>
    <div class="card">
      <div class="row-actions">
        <strong>Transport tier:</strong>
        <button
          :class="{ active: tier === 'fake' }"
          data-testid="net-tier-fake"
          :disabled="wifiStatus !== 'idle'"
          @click="tier = 'fake'"
        >
          Fake broker (offline)
        </button>
        <button
          :class="{ active: tier === 'real' }"
          data-testid="net-tier-real"
          :disabled="wifiStatus !== 'idle'"
          @click="tier = 'real'"
        >
          Real broker (WebSocket)
        </button>
      </div>
      <p class="hint">
        Broker: <code data-testid="net-broker">{{ brokerLabel }}</code>
        <span v-if="tier === 'real'">
          — change via <code>VITE_MQTT_WS_URL</code> in <code>.env</code></span
        >
      </p>
    </div>

    <div class="card">
      <div class="row-actions">
        <span>WiFi:</span>
        <span class="badge" :class="wifiStatus" data-testid="net-wifi-status">{{
          wifiStatus
        }}</span>
        <button
          class="action"
          data-testid="net-wifi-connect"
          :disabled="wifiStatus !== 'idle'"
          @click="connect"
        >
          {{ wifiStatus === 'connecting' ? 'Connecting…' : 'Connect WiFi' }}
        </button>
        <button data-testid="net-reset" :disabled="wifiStatus === 'idle'" @click="reset">
          Disconnect
        </button>
      </div>
      <div v-if="error" class="banner warn" data-testid="net-error">{{ error }}</div>
    </div>

    <div class="card device" :class="{ online: wifiStatus === 'connected' }">
      <h3>
        Simulated multi-sensor device <code>{{ deviceId }}</code>
      </h3>
      <div class="sensors">
        <label
          >Temperature
          <input
            type="range"
            min="0"
            max="4095"
            v-model.number="sensor"
            data-testid="net-sensor"
          /><span class="badge" data-testid="net-sensor-value">{{ sensor }}</span></label
        >
        <label
          >Humidity
          <input
            type="range"
            min="0"
            max="4095"
            v-model.number="humidity"
            data-testid="net-sensor-hum"
          /><span class="badge">{{ humidity }}</span></label
        >
        <label
          >Light
          <input
            type="range"
            min="0"
            max="4095"
            v-model.number="light"
            data-testid="net-sensor-light"
          /><span class="badge">{{ light }}</span></label
        >
      </div>
      <div class="row-actions">
        <button
          class="action"
          data-testid="net-publish"
          :disabled="wifiStatus !== 'connected'"
          @click="publish"
        >
          Publish telemetry
        </button>
        <button data-testid="net-auto" :disabled="wifiStatus !== 'connected'" @click="toggleAuto">
          Auto-publish: {{ auto ? 'on' : 'off' }}
        </button>
      </div>
      <div class="row-actions relay-row">
        <span>Relay / LED:</span>
        <span class="led" :class="{ on: relay }" />
        <span class="badge" data-testid="net-relay">{{ relay ? 'on' : 'off' }}</span>
        <button
          data-testid="net-cmd-on"
          :disabled="wifiStatus !== 'connected'"
          @click="command(true)"
        >
          Cloud → command ON
        </button>
        <button
          data-testid="net-cmd-off"
          :disabled="wifiStatus !== 'connected'"
          @click="command(false)"
        >
          Cloud → command OFF
        </button>
      </div>
    </div>

    <div class="card">
      <h3>HTTP request</h3>
      <div class="row-actions">
        <select v-model="httpMethod" data-testid="net-http-method">
          <option>GET</option>
          <option>POST</option>
        </select>
        <input class="grow" v-model="httpUrl" data-testid="net-http-url" />
        <input
          v-if="httpMethod === 'POST'"
          v-model="httpBody"
          data-testid="net-http-body"
          placeholder="body"
        />
        <button
          class="action"
          data-testid="net-http-send"
          :disabled="wifiStatus !== 'connected'"
          @click="sendHttp"
        >
          Send
        </button>
      </div>
      <pre v-if="httpResult" data-testid="net-http-result">{{ httpResult }}</pre>
    </div>

    <div class="logs">
      <div class="card">
        <h3>Published (device → broker)</h3>
        <ul class="log" data-testid="net-published">
          <li v-for="(l, i) in published" :key="i">{{ l }}</li>
        </ul>
      </div>
      <div class="card">
        <h3>Received (broker/HTTP → device)</h3>
        <ul class="log" data-testid="net-received">
          <li v-for="(l, i) in received" :key="i">{{ l }}</li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.hint {
  font-size: 0.82rem;
  opacity: 0.75;
  margin: 0.5rem 0 0;
}
.badge.idle {
  background: #6b7280;
}
.badge.connecting {
  background: #a16207;
}
.badge.connected {
  background: #16a34a;
}
.device {
  border-color: #cbd5e1;
}
.device.online {
  border-color: #16a34a;
}
.sensors {
  display: grid;
  gap: 0.4rem;
  margin: 0.5rem 0;
}
.sensors label {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.85rem;
}
.sensors input[type='range'] {
  flex: 1;
}
.relay-row {
  margin-top: 0.75rem;
}
.grow {
  flex: 1;
  min-width: 12rem;
}
.led {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: #4b5563;
  box-shadow: 0 0 0 3px #1f2937;
  transition: background 0.1s;
}
.led.on {
  background: #fde047;
  box-shadow:
    0 0 0 3px #1f2937,
    0 0 14px 5px rgba(253, 224, 71, 0.8);
}
.logs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}
.log {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 180px;
  overflow: auto;
  font-family: ui-monospace, monospace;
  font-size: 0.76rem;
}
.log li {
  padding: 0.15rem 0;
  border-bottom: 1px solid #f1f5f9;
}
button[disabled] {
  opacity: 0.5;
  cursor: default;
}
@media (max-width: 640px) {
  .logs {
    grid-template-columns: 1fr;
  }
}
</style>
