/**
 * Stage 7 — SVG sanitiser (security, gate #4). Board/component graphics and shared project
 * diagrams are SVG, which can carry active content (<script>, on* handlers, javascript: URLs,
 * <foreignObject> hosting HTML, XXE entities). Before ANY untrusted SVG is rendered it must be
 * stripped of those vectors. Pure string transform — works in Node + the browser; in the browser
 * it should be paired with a strict CSP for defence-in-depth.
 */

/** Remove all active/script content from an SVG string, keeping the visual markup. */
export function sanitizeSvg(svg: string): string {
  let s = svg;
  // DOCTYPE + ENTITY declarations (XXE / entity-expansion)
  s = s.replace(/<!DOCTYPE[\s\S]*?>/gi, '');
  s = s.replace(/<!ENTITY[\s\S]*?>/gi, '');
  // <script> … </script>, and any stray/self-closing <script …>
  s = s.replace(/<script[\s\S]*?<\/script\s*>/gi, '');
  s = s.replace(/<script\b[^>]*\/?>/gi, '');
  // <foreignObject> can host arbitrary HTML (and thus scripts)
  s = s.replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '');
  s = s.replace(/<foreignObject\b[^>]*\/?>/gi, '');
  // inline event handlers: on…="…" / on…='…' / on…=token
  s = s.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
  s = s.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
  s = s.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');
  // javascript: in URL-bearing attributes (href / xlink:href / src / from / to / …)
  s = s.replace(
    /((?:xlink:)?href|src|from|to|begin|values)\s*=\s*"\s*javascript:[^"]*"/gi,
    '$1="#"',
  );
  s = s.replace(
    /((?:xlink:)?href|src|from|to|begin|values)\s*=\s*'\s*javascript:[^']*'/gi,
    "$1='#'",
  );
  return s;
}

/** True if the SVG still contains active/script content (use to reject or to assert post-sanitise). */
export function svgHasActiveContent(svg: string): boolean {
  return /<script\b|<foreignObject\b|\son[a-z]+\s*=|javascript:|<!ENTITY|<!DOCTYPE/i.test(svg);
}
