#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export ARDUINO_DIRECTORIES_DATA="$HERE/build/arduino-data"
export ARDUINO_DIRECTORIES_DOWNLOADS="$ARDUINO_DIRECTORIES_DATA/downloads"
export ARDUINO_DIRECTORIES_USER="$HERE/build/arduino-user"
ACLI="$HERE/build/bin/arduino-cli"
echo "==> installing esp32:esp32@3.3.10 core (SDK + riscv32-esp-elf gcc)"
"$ACLI" core install esp32:esp32@3.3.10
echo "==> done; SDK at $ARDUINO_DIRECTORIES_DATA/packages/esp32"
ls "$ARDUINO_DIRECTORIES_DATA/packages/esp32/hardware/esp32/3.3.10/" 2>/dev/null | head
