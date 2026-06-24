#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/build"
if [ ! -d emsdk ]; then git clone --depth 1 https://github.com/emscripten-core/emsdk.git; fi
cd emsdk
./emsdk install 3.1.74
./emsdk activate 3.1.74
echo "EMSDK_READY"
./upstream/emscripten/emcc --version | head -1
