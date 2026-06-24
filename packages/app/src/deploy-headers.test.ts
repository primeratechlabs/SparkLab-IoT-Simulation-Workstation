/**
 * Deploy header drift guard — the classic bug is editing headers.config.mjs (so vite.config + the
 * Node server update) while a static deploy artifact silently keeps the old values and de-isolates in
 * production. This asserts the nginx include + the Netlify/Cloudflare _headers carry EVERY COOP/COEP/
 * CORP value and EVERY CSP directive from the single source, and never leak 'unsafe-eval'.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { coiHeaders, cspDirectives } from '../headers.config.mjs';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const nginx = read('../../../deploy/security-headers.conf');
const aapanel = read('../../../deploy/aapanel-nginx.conf');
const netlify = read('../public/_headers');

describe('deploy header drift guard', () => {
  for (const [k, v] of Object.entries(coiHeaders)) {
    it(`nginx + aapanel + _headers carry ${k}`, () => {
      expect(nginx).toContain(`${k} "${v}"`); // nginx: add_header K "V" always;
      expect(aapanel).toContain(`${k} "${v}"`);
      expect(netlify).toContain(`${k}: ${v}`); // _headers: K: V
    });
  }

  it('all artifacts carry every CSP directive and never leak unsafe-eval', () => {
    for (const d of cspDirectives) {
      expect(nginx).toContain(d);
      expect(aapanel).toContain(d);
      expect(netlify).toContain(d);
    }
    expect(nginx).not.toContain("'unsafe-eval'");
    expect(aapanel).not.toContain("'unsafe-eval'");
    expect(netlify).not.toContain("'unsafe-eval'");
  });
});
