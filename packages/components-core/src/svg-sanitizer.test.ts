import { describe, it, expect } from 'vitest';
import { sanitizeSvg, svgHasActiveContent } from './svg-sanitizer.js';

describe('svg-sanitizer (Stage 7, gate #4)', () => {
  it('strips <script> while keeping the drawing', () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="10" height="10"/></svg>`;
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toMatch(/<script/i);
    expect(clean).toContain('<rect width="10" height="10"/>');
    expect(svgHasActiveContent(clean)).toBe(false);
  });

  it('strips a self-closing <script> (the kind a browser extension injects)', () => {
    const dirty = `<svg><script xmlns="" id="eppiocemhmnlbhjplcgkofciiegomcon" /><path d="M0 0"/></svg>`;
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toMatch(/<script/i);
    expect(clean).toContain('<path d="M0 0"/>');
  });

  it('removes inline event handlers', () => {
    const clean = sanitizeSvg(`<svg onload="steal()"><circle r="5" onclick='hack()'/></svg>`);
    expect(clean).not.toMatch(/onload|onclick/i);
    expect(clean).toContain('<circle r="5"');
    expect(svgHasActiveContent(clean)).toBe(false);
  });

  it('neutralises javascript: URLs in href/xlink:href', () => {
    const clean = sanitizeSvg(
      `<svg><a xlink:href="javascript:alert(1)"><text>x</text></a><image href="javascript:evil()"/></svg>`,
    );
    expect(clean).not.toMatch(/javascript:/i);
    expect(clean).toContain('href="#"');
  });

  it('removes <foreignObject> (HTML/script host) and DOCTYPE/ENTITY (XXE)', () => {
    const dirty = `<!DOCTYPE svg [<!ENTITY x "y">]><svg><foreignObject><body onload="x()">hi</body></foreignObject><g/></svg>`;
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toMatch(/foreignObject|<!DOCTYPE|<!ENTITY/i);
    expect(clean).toContain('<g/>');
    expect(svgHasActiveContent(clean)).toBe(false);
  });

  it('leaves a clean board SVG untouched in spirit (no active content)', () => {
    const clean = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 57"><path id="d" fill="#333" d="m1 2 3-4z"/><rect x="1" y="1" width="12" height="13"/></svg>`;
    expect(svgHasActiveContent(clean)).toBe(false);
    expect(sanitizeSvg(clean)).toContain('<rect x="1" y="1" width="12" height="13"/>');
  });
});
