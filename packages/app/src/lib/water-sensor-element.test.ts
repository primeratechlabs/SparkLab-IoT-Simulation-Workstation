import { describe, it, expect } from 'vitest';
import { WaterLevelSensorElement, registerWaterSensorElement } from './water-sensor-element';

describe('<sparklab-water-sensor> element (wokwi-style LitElement)', () => {
  it('registers the custom element (idempotent)', () => {
    registerWaterSensorElement();
    registerWaterSensorElement(); // second call must not throw
    expect(customElements.get('sparklab-water-sensor')).toBe(WaterLevelSensorElement);
  });

  it('exposes wokwi-compatible pinInfo with wokwi signal descriptors (analog / VCC / GND)', () => {
    const pins = new WaterLevelSensorElement().pinInfo;
    expect(pins.map((p) => p.name)).toEqual(['SIG', 'VCC', 'GND']);
    for (const p of pins) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    // signals carry the wokwi role shape, so the canvas reads roles like a real wokwi element
    expect(pins[0]!.signals[0]).toMatchObject({ type: 'analog', channel: 0 });
    expect(pins[1]!.signals[0]).toMatchObject({ type: 'power', signal: 'VCC' });
    expect(pins[2]!.signals[0]).toMatchObject({ type: 'power', signal: 'GND' });
  });

  it('is a reactive LitElement: the water fill WIDTH grows with the `level` property (computed, not fixed)', async () => {
    const el = document.createElement('sparklab-water-sensor') as WaterLevelSensorElement;
    el.level = 10;
    document.body.appendChild(el);
    await el.updateComplete;
    const fill = () => el.shadowRoot?.querySelector('rect.water-fill') as SVGRectElement | null;
    expect(el.shadowRoot?.querySelector('svg')).toBeTruthy();
    const low = Number(fill()?.getAttribute('width'));
    el.level = 90; // reactive property → Lit re-renders
    await el.updateComplete;
    const high = Number(fill()?.getAttribute('width'));
    expect(high).toBeGreaterThan(low); // water rises from the blade tip (left) → wider fill
    el.remove();
  });
});
