#!/usr/bin/env bash
# Build the arduino-avr-core SDK pack: avr-libc + libgcc + crt + ArduinoCore-avr's
# core.a, plus headers — the link inputs a sketch needs to become runnable firmware.
# Built with the HOST avr-gcc (Arduino-standard ABI). NOTE: the host gcc here is 5.x
# while the wasm cc1 is 14.2; avr-libc/crt are gcc-version-independent, libgcc is the
# only version-sensitive piece — Blink-class sketches use little/none of it. Verified
# empirically by the full-chain test.
set -euo pipefail

MCU=atmega328p
MULTILIB=avr5
FCPU=16000000L
OUTDIR="$OUT/arduino-avr-core"
mkdir -p "$OUTDIR/lib/$MULTILIB" "$OUTDIR/headers"

# avr-libc: multilib archives (libc.a, libm.a) + the device crt + all headers.
cp "/usr/lib/avr/lib/$MULTILIB/"*.a "$OUTDIR/lib/$MULTILIB/" 2>/dev/null || true
cp "/usr/lib/avr/lib/$MULTILIB/crt${MCU}.o" "$OUTDIR/lib/crt${MCU}.o" 2>/dev/null \
  || cp "/usr/lib/avr/lib/crt${MCU}.o" "$OUTDIR/lib/crt${MCU}.o" 2>/dev/null \
  || echo "WARN: crt${MCU}.o not found"
cp -r /usr/lib/avr/include/. "$OUTDIR/headers/"

# libgcc for the multilib (compiler support routines).
LIBGCC=$(find /usr/lib/gcc/avr -path "*/${MULTILIB}/libgcc.a" 2>/dev/null | head -1)
[ -n "$LIBGCC" ] && cp "$LIBGCC" "$OUTDIR/lib/$MULTILIB/libgcc.a" || echo "WARN: libgcc.a ($MULTILIB) not found"

# ArduinoCore-avr → core.a (reproducible flags §11/I4).
ARDUINO_CORE_REF="${ARDUINO_CORE_REF:-1.8.6}"
[ -d /build/ArduinoCore-avr ] || git clone --depth 1 --branch "${ARDUINO_CORE_REF}" \
  https://github.com/arduino/ArduinoCore-avr.git /build/ArduinoCore-avr
CORE=/build/ArduinoCore-avr/cores/arduino
VARIANT=/build/ArduinoCore-avr/variants/standard
# NOTE: host avr-gcc is 5.x → use -fdebug-prefix-map (it lacks -ffile-prefix-map,
# added in gcc 8). Deterministic archive comes from `ar D`. core.a is built once on
# CI and shipped (clients never rebuild it), so this is sufficient for the pack.
REPRO="-fdebug-prefix-map=/build=. -frandom-seed=arduino-core"

OBJDIR=/tmp/coreobj
rm -rf "$OBJDIR"; mkdir -p "$OBJDIR"
cd "$CORE"
for f in *.c; do
  avr-gcc -mmcu=$MCU -DF_CPU=$FCPU -DARDUINO=10806 -Os -ffunction-sections -fdata-sections \
    $REPRO -I"$CORE" -I"$VARIANT" -c "$f" -o "$OBJDIR/${f%.c}.o"
done
for f in *.cpp; do
  avr-g++ -mmcu=$MCU -DF_CPU=$FCPU -DARDUINO=10806 -Os -ffunction-sections -fdata-sections -fno-exceptions \
    $REPRO -I"$CORE" -I"$VARIANT" -c "$f" -o "$OBJDIR/${f%.cpp}.o"
done
# Assembly sources (.S): the core ships hand-written asm — notably wiring_pulse.S, which defines
# `countPulseASM` that the library `pulseIn()` calls. Skipping these left pulseIn() with an undefined
# reference at link time (curriculum HC-SR04 sketches use pulseIn). avr-gcc -c preprocesses + assembles.
for f in *.S; do
  [ -e "$f" ] || continue
  # Keep the extension (wiring_pulse.S.o) so it does NOT clobber wiring_pulse.c's wiring_pulse.o —
  # the core ships both (the .c has pulseIn(), the .S defines countPulseASM); both are needed.
  avr-gcc -mmcu=$MCU -DF_CPU=$FCPU -DARDUINO=10806 -Os -ffunction-sections -fdata-sections \
    $REPRO -I"$CORE" -I"$VARIANT" -c "$f" -o "$OBJDIR/${f}.o"
done
NOBJ=$(ls "$OBJDIR"/*.o 2>/dev/null | wc -l)
[ "$NOBJ" -gt 0 ] || { echo "FATAL: no core objects compiled"; exit 1; }
echo "compiled $NOBJ core objects"
avr-ar rcsD "$OUTDIR/lib/core.a" "$OBJDIR"/*.o
cp "$CORE"/*.h "$VARIANT"/pins_arduino.h "$OUTDIR/headers/" 2>/dev/null || true

echo "arduino-avr-core complete:"
echo "  core.a: $(du -h "$OUTDIR/lib/core.a" | cut -f1)"
ls "$OUTDIR/lib/" "$OUTDIR/lib/$MULTILIB/"
