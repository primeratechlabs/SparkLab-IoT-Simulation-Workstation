/* Flat layout for the Xtensa sim profile: .literal MUST precede .text so L32R (which can only
 * reference backward) resolves. Base 0; the emulator loads the image there and runs from the
 * entry symbol.
 *
 * ⚠ MAINTENANCE RULE (xtensa-core audit): a CUSTOM SECTIONS{} block does NOT auto-bracket orphan input
 * sections the way the C3 `-Ttext=0` link does. So EVERY link section the firmware emits entries into
 * (via __attribute__((section("X")))) or iterates (via __start_X/__stop_X) MUST be explicitly placed,
 * KEEP'd (against --gc-sections), and have its __start_/__stop_ bracket symbols PROVIDE'd HERE — or it
 * silently collapses to an empty range on Xtensa (works on C3), the exact bug that made Blynk dead on
 * classic. The pure test xtensa-link-sections.test.ts enforces this mechanically; keep them in sync.
 * (Current bracketed sections: blynk_handlers, blynk_connected.) */
ENTRY(_start)
SECTIONS {
  . = 0;
  .text : {
    *(.literal .literal.*) *(.text .text.*) *(.rodata .rodata.*)
    /* Blynk handler tables. A CUSTOM SECTIONS script does NOT auto-bracket __start_/__stop_ orphan
     * sections the way the C3 default `-Ttext=0` link does, so on Xtensa the firmware found ZERO
     * registered BLYNK_WRITE/BLYNK_CONNECTED handlers (__start_ == __stop_) and never polled the
     * dashboard → the V0 switch could never reach the LED. Place + KEEP them (defeat --gc-sections)
     * and define the bracket symbols Blynk.run()/syncVirtual()/blynk_fire_connected() iterate. */
    . = ALIGN(4);
    PROVIDE(__start_blynk_handlers = .);
    KEEP(*(blynk_handlers))
    PROVIDE(__stop_blynk_handlers = .);
    . = ALIGN(4);
    PROVIDE(__start_blynk_connected = .);
    KEEP(*(blynk_connected))
    PROVIDE(__stop_blynk_connected = .);
  }
  .data : {
    /* C++ global constructors (.init_array). It is a WRITABLE section (SHF_WRITE), so it MUST live in a
     * writable output section — placing it in read-only .text makes lld orphan it (the bracket symbols
     * collapse to an empty range and run_global_ctors() runs nothing). The C3 `-Ttext=0` default script
     * brackets these for free; the custom Xtensa script must do it here so a sketch/library with a
     * non-trivial global object ctor is actually initialised. */
    . = ALIGN(4);
    PROVIDE(__init_array_start = .);
    KEEP(*(SORT_BY_INIT_PRIORITY(.init_array.*) SORT_BY_INIT_PRIORITY(.ctors.*)))
    KEEP(*(.init_array))
    KEEP(*(.ctors))
    PROVIDE(__init_array_end = .);
    *(.data .data.*)
  }
  .bss  : { *(.bss .bss.*) *(COMMON) }
  /* End of the image — the sim runtime's malloc grows the heap up from here toward the stack. */
  _end = .;
}
