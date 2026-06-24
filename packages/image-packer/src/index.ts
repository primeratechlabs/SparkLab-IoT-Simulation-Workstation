/**
 * Image packer — placeholder interface for Stage 1. Turns a linked ELF into a
 * flashable image:
 *   - Stage 2: AVR ELF → Intel HEX (port of elf2hex).
 *   - Stage 4: ESP32 ELF → bootloader/partitions/app/merged flash image
 *     (port of esptool elf2image/merge_bin; esptool-js lacks elf2image).
 * Only the contract is defined here so the BuildDaemon can depend on a stable
 * shape now and gain real packing later without interface churn.
 */

export * from './avr.js';
export * from './esp32.js';

import type { ImageResult } from '@sparklab/shared';

export type ImageFormat = 'hex' | 'esp-flash';

export interface ImagePacker {
  readonly format: ImageFormat;
  readonly version: string;
  pack(elf: Uint8Array): Promise<ImageResult>;
}

/** Stage 1 stub: not yet implemented — real packers arrive in Stage 2/4. */
export class PlaceholderImagePacker implements ImagePacker {
  readonly version = 'stub-packer@1';
  constructor(readonly format: ImageFormat = 'hex') {}

  async pack(_elf: Uint8Array): Promise<ImageResult> {
    return { status: 'error', timeMs: 0 };
  }
}
