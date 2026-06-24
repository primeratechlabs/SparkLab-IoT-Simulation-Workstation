import { describe, it, expect } from 'vitest';
import { FakeMqttBroker, type MqttMessage } from './mqtt.js';

describe('network-shim — FakeMqttBroker', () => {
  it('delivers a published message to subscribers of that exact topic', () => {
    const broker = new FakeMqttBroker();
    const got: MqttMessage[] = [];
    broker.subscribe('sparklab/cmd', (m) => got.push(m));
    broker.subscribe('other/topic', () => {
      throw new Error('wrong topic');
    });

    broker.publish('sparklab/cmd', '1');
    expect(got).toEqual([{ topic: 'sparklab/cmd', payload: '1' }]);
  });

  it('records every publish and exposes the latest per topic', () => {
    const broker = new FakeMqttBroker();
    broker.publish('telemetry', '100');
    broker.publish('telemetry', '200');
    broker.publish('status', 'ok');
    expect(broker.published).toHaveLength(3);
    expect(broker.last('telemetry')).toEqual({ topic: 'telemetry', payload: '200' });
    expect(broker.last('status')?.payload).toBe('ok');
    expect(broker.last('missing')).toBeUndefined();
  });

  it('inject() simulates a cloud→device command reaching the subscription', () => {
    const broker = new FakeMqttBroker();
    let received = '';
    broker.subscribe('dev/42/cmd', (m) => {
      received = m.payload;
    });
    broker.inject('dev/42/cmd', 'RELAY=1');
    expect(received).toBe('RELAY=1');
    expect(broker.connected()).toBe(true);
  });

  it('multiple subscribers on one topic all fire', () => {
    const broker = new FakeMqttBroker();
    const hits: number[] = [];
    broker.subscribe('t', () => hits.push(1));
    broker.subscribe('t', () => hits.push(2));
    broker.publish('t', 'x');
    expect(hits).toEqual([1, 2]);
  });
});
