import { describe, it, expect } from 'vitest';
import {
  ESP32C3_TARGET,
  esp32CompileFlags,
  esp32LinkArgs,
  esp32SdkHeaderFlags,
} from './esp32-target.js';

describe('ESP32-C3 target', () => {
  it('is a 32-bit RISC-V target with the arduino-esp32 defines (verified march/offsets)', () => {
    expect(ESP32C3_TARGET.march).toBe('rv32imc_zicsr_zifencei'); // matches SDK multilib
    expect(ESP32C3_TARGET.defines).toEqual(
      expect.arrayContaining([
        '-DESP32=ESP32',
        '-DARDUINO_ARCH_ESP32',
        '-DCONFIG_IDF_TARGET_ESP32C3=1',
      ]),
    );
    // C3 boots from flash 0x0 (verified against the real esptool merged.bin), not 0x1000.
    expect(ESP32C3_TARGET.flashOffsets).toEqual({
      bootloader: 0x0,
      partitions: 0x8000,
      app: 0x10000,
    });
  });

  it('compile flags carry the clang triple, march/mabi and SDK-faithful flags', () => {
    const flags = esp32CompileFlags();
    expect(flags).toContain('--target=riscv32-esp-elf');
    expect(flags).toContain('-march=rv32imc_zicsr_zifencei');
    expect(flags).toContain('-mabi=ilp32');
    expect(flags).toContain('-fexceptions'); // arduino-esp32 C3 enables exceptions (SDK cpp_flags)
    expect(flags).toContain('-fno-rtti');
    expect(flags).toContain('-DESP32=ESP32');
    expect(esp32CompileFlags(ESP32C3_TARGET, ['-I/sdk/foo'])).toContain('-I/sdk/foo');
  });

  it('SDK header flags make clang use gcc newlib + libstdc++ (ABI gate verified)', () => {
    const f = esp32SdkHeaderFlags('/sdk/gcc');
    expect(f).toContain('--sysroot=/sdk/gcc/riscv32-esp-elf');
    expect(f).toContain('-stdlib=libstdc++');
    expect(f).toContain('-nobuiltininc'); // use gcc's C headers, not clang's builtin stdint.h
    // the multilib-specific libstdc++ bits dir (c++config.h) must be on the system path
    expect(f).toContain(
      '-isystem/sdk/gcc/riscv32-esp-elf/include/c++/14.2.0/riscv32-esp-elf/rv32imc_zicsr_zifencei/ilp32',
    );
  });

  it('link args wrap the SDK archives in --start-group/--end-group (arduino-esp32 #4209)', () => {
    const args = esp32LinkArgs(['sketch.o'], ['libcore.a', 'libidf.a'], ['esp32c3.ld']);
    const gs = args.indexOf('--start-group');
    const ge = args.indexOf('--end-group');
    expect(gs).toBeGreaterThan(-1);
    expect(ge).toBeGreaterThan(gs);
    expect(args.slice(gs + 1, ge)).toEqual(['libcore.a', 'libidf.a']); // libs inside the group
    expect(args).toContain('-T'); // linker script passed
    expect(args).toContain('--gc-sections');
  });
});
