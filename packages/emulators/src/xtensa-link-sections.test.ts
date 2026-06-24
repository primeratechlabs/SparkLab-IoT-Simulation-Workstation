/**
 * STRUCTURAL SAFEGUARD (xtensa-core audit) — prevents a recurrence of the Blynk-dead-on-classic class.
 *
 * The ESP32-C3 link uses `-Ttext=0`, where lld synthesizes a default layout that AUTO-brackets every
 * orphan input section (creates __start_X/__stop_X for any section X). The ESP32-classic link uses a
 * CUSTOM `xtensa-flat.ld` SECTIONS{} block, which does NOT auto-bracket — any section the script forgets
 * to place silently collapses to an empty range (__start_X == __stop_X) with NO link error, and the
 * firmware that iterates it finds zero entries (exactly what killed BLYNK_WRITE on classic).
 *
 * So: every link section the firmware emits entries into (via __attribute__((section("X")))) or iterates
 * (via __start_X/__stop_X) MUST be explicitly KEEP'd + bracketed in xtensa-flat.ld. This pure test
 * cross-references the two and fails the moment a new section is added without placing it — mechanically,
 * not by convention. Runs in CI with no toolchain dependency.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const runtimeCpp = join(here, 'sim-runtime', 'esp32c3-arduino-sim.cpp');
const xtensaLd = join(here, 'sim-runtime', 'xtensa-flat.ld');
const sparkBlynkDir = join(here, '__fixtures__', 'SparkBlynk');

/** Read the firmware HAL shim + every Spark/Blynk header the build links (where the section macros live). */
function firmwareSources(): string[] {
  const out = [readFileSync(runtimeCpp, 'utf8')];
  for (const f of readdirSync(sparkBlynkDir)) {
    if (f.endsWith('.h')) out.push(readFileSync(join(sparkBlynkDir, f), 'utf8'));
  }
  return out;
}

/** Custom link sections the firmware places entries into or brackets-iterate. Excludes the standard
 *  toolchain sections (.text/.data/.bss/.rodata/.literal/.init_array) the script handles generically. */
function firmwareLinkSections(): Set<string> {
  const sections = new Set<string>();
  for (const src of firmwareSources()) {
    for (const m of src.matchAll(/section\("([A-Za-z_][\w.]*)"\)/g)) sections.add(m[1]!);
    for (const m of src.matchAll(/__start_([A-Za-z_]\w*)\b/g)) sections.add(m[1]!);
    for (const m of src.matchAll(/__stop_([A-Za-z_]\w*)\b/g)) sections.add(m[1]!);
  }
  // Drop names that begin with a dot (standard sections) — only custom bracket-iterated tables matter here.
  return new Set([...sections].filter((s) => !s.startsWith('.')));
}

describe('xtensa-flat.ld — every firmware link-section is placed + bracketed (audit safeguard)', () => {
  const ld = readFileSync(xtensaLd, 'utf8');
  const sections = firmwareLinkSections();

  it('discovers the firmware custom link sections (sanity — at least Blynk handler tables)', () => {
    expect(sections.has('blynk_handlers')).toBe(true);
    expect(sections.has('blynk_connected')).toBe(true);
  });

  it('KEEPs + brackets (__start_/__stop_) every firmware section in the custom Xtensa linker script', () => {
    for (const sec of sections) {
      // KEEP defeats --gc-sections; the bracket symbols are what the firmware iterates. A custom SECTIONS
      // block does not provide these automatically, so a missing one collapses the section silently.
      expect(ld, `xtensa-flat.ld must KEEP(*(${sec})) — else --gc-sections drops it`).toContain(
        `KEEP(*(${sec}))`,
      );
      expect(
        ld,
        `xtensa-flat.ld must PROVIDE __start_${sec} — else the firmware iterates an empty range`,
      ).toContain(`__start_${sec}`);
      expect(ld, `xtensa-flat.ld must PROVIDE __stop_${sec}`).toContain(`__stop_${sec}`);
    }
  });
});
