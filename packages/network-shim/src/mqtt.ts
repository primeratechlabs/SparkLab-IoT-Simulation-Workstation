/**
 * Stage 6 — MQTT pub/sub (the canonical IoT messaging pattern: publish sensor telemetry, receive
 * commands). Tier 1 is a fully client-side fake broker (no backend, I8) — enough to teach the
 * publish/subscribe model deterministically. Tier 2 (MQTT over a real WebSocket broker) and Tier 3
 * (gateway) implement the SAME MqttTransport, so a sketch is unchanged across tiers.
 */

export interface MqttMessage {
  topic: string;
  payload: string;
}
export type MqttSubscriber = (msg: MqttMessage) => void;

/** What the MQTT MMIO peripheral talks to, independent of tier. */
export interface MqttTransport {
  connected(): boolean;
  publish(topic: string, payload: string): void | Promise<void>;
  subscribe(topic: string, onMessage: MqttSubscriber): void | Promise<void>;
}

/**
 * Tier-1 fake MQTT broker. Exact-topic routing (no wildcards in tier 1), synchronous delivery,
 * and a record of everything published for test assertions. `inject()` simulates a message
 * arriving from "the cloud" (e.g. a dashboard command) so the device's subscription fires.
 */
export class FakeMqttBroker implements MqttTransport {
  private readonly subs = new Map<string, MqttSubscriber[]>();
  /** Every message published to the broker (by the device or via inject), in order. */
  readonly published: MqttMessage[] = [];

  connected(): boolean {
    return true;
  }

  publish(topic: string, payload: string): void {
    const msg: MqttMessage = { topic, payload };
    this.published.push(msg);
    for (const h of this.subs.get(topic) ?? []) h(msg);
  }

  subscribe(topic: string, onMessage: MqttSubscriber): void {
    const arr = this.subs.get(topic) ?? [];
    arr.push(onMessage);
    this.subs.set(topic, arr);
  }

  /** Deliver a message from outside the device (cloud → device command). */
  inject(topic: string, payload: string): void {
    this.publish(topic, payload);
  }

  /** Most recent message on a topic, or undefined. */
  last(topic: string): MqttMessage | undefined {
    for (let i = this.published.length - 1; i >= 0; i--) {
      if (this.published[i]!.topic === topic) return this.published[i];
    }
    return undefined;
  }
}
