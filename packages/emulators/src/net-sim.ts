/**
 * Stage 6 — network MMIO peripheral (sim). Bridges the firmware's WiFi/HTTP HAL (sim-runtime)
 * to the @sparklab/network-shim Tier-1 fake network. Architecture-neutral like the other SoC
 * blocks (works on both the rv32 C3 core and the Xtensa classic core via the shared bus).
 *
 * Doctrine: this is the API → HAL → MMIO bottom layer for networking. `WiFi.begin()/status()`
 * (real arduino-esp32) and the Sparklab HTTP helper write/read these registers; the peripheral
 * routes the request to the Tier-1 fake server and streams the response back. backend=0 (I8) —
 * "internet" here is a local deterministic model. Tier 2 (browser fetch) / Tier 3 (real gateway)
 * swap the delegate behind the same registers without changing firmware.
 *
 * Register map (relative to C3_NET_BASE):
 *   0x00 WIFI_SSID   (w8)  append one SSID char
 *   0x04 WIFI_BEGIN  (w)   WiFi.begin(ssid) — start the connect
 *   0x08 WIFI_STATUS (r)   poll + return wl_status_t (advances the connect each read)
 *   0x10 REQ_CHAR    (w8)  append one request-buffer char ("METHOD host:port path\nbody")
 *   0x14 HTTP_SEND   (w)   send the buffered request → transport; latch the response
 *   0x18 HTTP_STATUS (r)   response status code (200, or 0 if not connected / no route)
 *   0x1c RX_AVAIL    (r)   response body bytes still unread
 *   0x20 RX_CHAR     (r)   pop one response body byte (0 when drained)
 *   0x24 HTTP_READY  (r)   1 when the response has landed (Tier 1: immediate; Tier 2: after the
 *                          async fetch resolves — firmware spins on this; the run loop must yield)
 *
 *   MQTT (optional, when an MqttTransport is provided):
 *   0x30 MQTT_TOPIC  (w8)  append one topic char
 *   0x34 MQTT_PAY    (w8)  append one payload char
 *   0x38 MQTT_PUB    (w)   publish {topic, payload} (when WiFi up); clear both buffers
 *   0x3c MQTT_SUB    (w)   subscribe to the topic buffer; clear it (incoming msgs are queued)
 *   0x40 MQTT_AVAIL  (r)   queued incoming message count
 *   0x44 MQTT_RX     (r)   pop one payload byte of the front incoming message (0 when drained)
 *   0x48 MQTT_NEXT   (w)   drop the front incoming message (advance)
 *
 *   Blynk presence (optional, when a BlynkPresence is provided) — the persistent MQTT-over-WebSocket
 *   device session that makes the device show "online" on the real Blynk dashboard (data still flows
 *   over the pin-based HTTP Device API above; this is online status only):
 *   0x50 BLYNK_TOKEN  (w8)  append one auth-token char
 *   0x54 BLYNK_BEGIN  (w)   open the device session with the buffered token; clear it
 *   0x58 BLYNK_STATUS (r)   0 idle · 1 connecting · 2 connected (online) · 3 failed/dropped
 *   0x5c BLYNK_PING   (r)   handshake round-trip in ms (for the firmware's "Ready (ping: Xms)" log)
 */
import type { Rv32Bus } from './rv32.js';
import {
  type NetworkTransport,
  type MqttTransport,
  type BlynkPresence,
  WL_CONNECTED,
  parseHalRequest,
} from '@sparklab/network-shim';

/** Optional network wiring for a SoC runner: a transport (Tier 1 fake / Tier 2 fetch) + optional MQTT
 *  + optional Blynk presence. When present, the runner maps a {@link C3Net} at {@link C3_NET_BASE} so the
 *  firmware's WiFi/HTTP/MQTT/Blynk HAL is serviced — same on the rv32 C3 core and the Xtensa classic
 *  core (the MMIO map is neutral). */
export interface SocNetworkOpts {
  transport?: NetworkTransport;
  mqtt?: MqttTransport;
  blynk?: BlynkPresence;
}

export const C3_NET_BASE = 0x60022000;
const WIFI_SSID = 0x00;
const WIFI_BEGIN = 0x04;
const WIFI_STATUS = 0x08;
const REQ_CHAR = 0x10;
const HTTP_SEND = 0x14;
const HTTP_STATUS = 0x18;
const RX_AVAIL = 0x1c;
const RX_CHAR = 0x20;
const HTTP_READY = 0x24;
const MQTT_TOPIC = 0x30;
const MQTT_PAY = 0x34;
const MQTT_PUB = 0x38;
const MQTT_SUB = 0x3c;
const MQTT_AVAIL = 0x40;
const MQTT_RX = 0x44;
const MQTT_NEXT = 0x48;
const BLYNK_TOKEN = 0x50;
const BLYNK_BEGIN = 0x54;
const BLYNK_STATUS = 0x58;
const BLYNK_PING = 0x5c;

export class C3Net implements Partial<Rv32Bus> {
  private ssid = '';
  private req = '';
  private respStatus = 0;
  private respBody = '';
  private rxIdx = 0;
  private ready = 1; // 1 = idle/response-available; 0 = a request is in flight (async)
  private mqttTopic = '';
  private mqttPayload = '';
  private readonly mqttRx: string[] = []; // queued incoming payloads
  private mqttRxIdx = 0; // byte cursor into the front incoming message
  private blynkToken = '';

  constructor(
    readonly net: NetworkTransport,
    readonly mqtt?: MqttTransport,
    readonly blynk?: BlynkPresence,
  ) {}

  private store(off: number, v: number): void {
    const ch = String.fromCharCode(v & 0xff);
    switch (off) {
      case WIFI_SSID:
        this.ssid += ch;
        return;
      case WIFI_BEGIN:
        this.net.wifi.begin(this.ssid || 'sparklab');
        this.ssid = '';
        return;
      case REQ_CHAR:
        this.req += ch;
        return;
      case HTTP_SEND: {
        const res = this.net.fetch(parseHalRequest(this.req));
        this.req = '';
        this.ready = 0;
        this.respStatus = 0;
        this.respBody = '';
        this.rxIdx = 0;
        if (res instanceof Promise) {
          res.then((r) => this.latch(r.status, r.body)); // Tier 2: resolve later
        } else {
          this.latch(res.status, res.body); // Tier 1: synchronous
        }
        return;
      }
      case MQTT_TOPIC:
        this.mqttTopic += ch;
        return;
      case MQTT_PAY:
        this.mqttPayload += ch;
        return;
      case MQTT_PUB:
        if (this.mqtt && this.net.wifi.status() === WL_CONNECTED) {
          void this.mqtt.publish(this.mqttTopic, this.mqttPayload);
        }
        this.mqttTopic = '';
        this.mqttPayload = '';
        return;
      case MQTT_SUB:
        if (this.mqtt) void this.mqtt.subscribe(this.mqttTopic, (m) => this.mqttRx.push(m.payload));
        this.mqttTopic = '';
        return;
      case MQTT_NEXT:
        this.mqttRx.shift();
        this.mqttRxIdx = 0;
        return;
      case BLYNK_TOKEN:
        this.blynkToken += ch;
        return;
      case BLYNK_BEGIN:
        if (this.blynk) this.blynk.begin(this.blynkToken);
        this.blynkToken = '';
        return;
    }
  }
  private latch(status: number, body: string): void {
    this.respStatus = status;
    this.respBody = body;
    this.rxIdx = 0;
    this.ready = 1;
  }
  private load(off: number): number {
    switch (off) {
      case WIFI_STATUS:
        this.net.wifi.poll();
        return this.net.wifi.status();
      case HTTP_STATUS:
        return this.respStatus;
      case RX_AVAIL:
        return Math.max(0, this.respBody.length - this.rxIdx);
      case RX_CHAR:
        return this.rxIdx < this.respBody.length
          ? this.respBody.charCodeAt(this.rxIdx++) & 0xff
          : 0;
      case HTTP_READY:
        return this.ready;
      case MQTT_AVAIL:
        return this.mqttRx.length;
      case MQTT_RX: {
        const front = this.mqttRx[0];
        if (front === undefined || this.mqttRxIdx >= front.length) return 0;
        return front.charCodeAt(this.mqttRxIdx++) & 0xff;
      }
      case BLYNK_STATUS:
        return this.blynk ? this.blynk.status() : 0;
      case BLYNK_PING:
        return this.blynk ? this.blynk.pingMs() : 0;
      default:
        return 0;
    }
  }

  write32(addr: number, v: number): void {
    this.store(addr - C3_NET_BASE, v >>> 0);
  }
  write8(addr: number, v: number): void {
    this.store(addr - C3_NET_BASE, v & 0xff);
  }
  write16(addr: number, v: number): void {
    this.store(addr - C3_NET_BASE, v & 0xffff);
  }
  read32(addr: number): number {
    return this.load(addr - C3_NET_BASE) >>> 0;
  }
  read8(addr: number): number {
    return this.load((addr & ~3) - C3_NET_BASE) & 0xff;
  }
  read16(addr: number): number {
    return this.load((addr & ~3) - C3_NET_BASE) & 0xffff;
  }
}
