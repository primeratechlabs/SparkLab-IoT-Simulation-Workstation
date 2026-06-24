import { describe, it, expect } from 'vitest';
import {
  canonicalJson,
  serializeDocument,
  documentHash,
  parseDocument,
  DocumentParseError,
} from './serialize.js';
import { emptyDocument, newComponent } from './document.js';
import { MCU_REF, type CircuitDocument } from './types.js';

function sample(): CircuitDocument {
  const doc = emptyDocument('p1', 'sample', { now: 100 });
  doc.components.push(newComponent('led1', 'led', 100, 50));
  doc.wires.push({
    id: 'w1',
    from: { component: 'led1', pin: 'anode' },
    to: { component: MCU_REF, pin: 'D13' },
  });
  return doc;
}

/** Re-insert all object keys in reverse order — content identical, key order shuffled. */
function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).reverse())
      out[k] = reverseKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

describe('serialize — canonical form', () => {
  it('is independent of object key insertion order', () => {
    const doc = sample();
    const shuffled = reverseKeys(doc) as CircuitDocument;
    expect(canonicalJson(doc)).toBe(canonicalJson(shuffled));
  });

  it('preserves meaningful array order (component z-order)', () => {
    const doc = sample();
    doc.components.push(newComponent('led2', 'led', 0, 0));
    const json = canonicalJson(doc);
    expect(json.indexOf('led1')).toBeLessThan(json.indexOf('led2'));
  });

  it('serializeDocument is pretty-printed and round-trips through parseDocument', () => {
    const doc = sample();
    const text = serializeDocument(doc);
    expect(text).toContain('\n'); // pretty
    expect(parseDocument(text)).toEqual(doc);
  });
});

describe('serialize — documentHash', () => {
  it('is stable for equal content and changes when content changes', async () => {
    const a = await documentHash(sample());
    const b = await documentHash(reverseKeys(sample()) as CircuitDocument);
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);

    const moved = sample();
    moved.components[0]!.x = 999;
    expect(await documentHash(moved)).not.toBe(a);
  });
});

describe('serialize — parseDocument validation', () => {
  it('throws on malformed input', () => {
    expect(() => parseDocument('not json')).toThrow(DocumentParseError);
    expect(() => parseDocument('[]')).toThrow(DocumentParseError);
    expect(() => parseDocument('{"id":"x"}')).toThrow(/schemaVersion|name|board/);
  });

  it('deep-validates component/wire shapes + rotation (the OPFS trust boundary)', () => {
    const ok = serializeDocument(sample());
    expect(() => parseDocument(ok)).not.toThrow();

    const badRot = JSON.parse(ok);
    badRot.components[0].rotation = 45;
    expect(() => parseDocument(JSON.stringify(badRot))).toThrow(/rotation/);

    const badComp = JSON.parse(ok);
    badComp.components.push({ id: 'x' }); // missing type/x/y/rotation/props
    expect(() => parseDocument(JSON.stringify(badComp))).toThrow(/components\[/);

    const badWire = JSON.parse(ok);
    badWire.wires.push({ id: 'w', from: null, to: { component: 'a', pin: 'b' } });
    expect(() => parseDocument(JSON.stringify(badWire))).toThrow(/wires\[/);
  });
});
