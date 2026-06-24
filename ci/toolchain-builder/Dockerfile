# AVR toolchain → WASM builder image.
# Pins emsdk + source versions for reproducibility (§11). Run produces /out artifacts.
FROM emscripten/emsdk:3.1.74

# Host AVR toolchain (for building core.a / avr-libc with the Arduino-standard ABI)
# plus build prerequisites for the Canadian-cross gcc build.
RUN apt-get update && apt-get install -y --no-install-recommends \
      gcc-avr avr-libc binutils-avr \
      build-essential texinfo bison flex wget xz-utils file \
    && rm -rf /var/lib/apt/lists/*

# Pinned source versions (override at build time with --build-arg if needed).
ENV BINUTILS_VERSION=2.43 \
    GCC_VERSION=14.2.0 \
    AVRLIBC_VERSION=2.2.1 \
    AVR_TARGET=avr \
    PREFIX=/opt/avr-wasm \
    OUT=/out

WORKDIR /build
COPY *.sh /build/
RUN chmod +x /build/*.sh

# Single entrypoint: binutils → gcc → avr-libc/core.a. Each step writes to /out.
ENTRYPOINT ["/build/build-all.sh"]
