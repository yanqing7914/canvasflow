#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sherpa_commit="e1edbfee666116b6c2c0129b377055b4e096b3c9"
emsdk_version="4.0.23"
source_dir="${SHERPA_ONNX_SOURCE:-$root/.canvasflow/sherpa-onnx-$sherpa_commit}"
output_dir="$root/apps/demo/public/voice/kws"
assets_dir="$source_dir/wasm/kws/assets"

if [[ -z "${EMSCRIPTEN:-}" ]]; then
  echo "EMSCRIPTEN must point to emsdk $emsdk_version/upstream/emscripten" >&2
  exit 2
fi
if [[ ! -f "$EMSCRIPTEN/cmake/Modules/Platform/Emscripten.cmake" ]]; then
  echo "invalid EMSCRIPTEN path: $EMSCRIPTEN" >&2
  exit 2
fi
if [[ ! -x "$EMSCRIPTEN/emcc" ]] || ! "$EMSCRIPTEN/emcc" --version | head -n 1 | grep -Fq "$emsdk_version"; then
  echo "EMSCRIPTEN must use pinned emsdk $emsdk_version" >&2
  exit 2
fi

if [[ ! -d "$source_dir/.git" ]]; then
  mkdir -p "$(dirname "$source_dir")"
  git clone --filter=blob:none https://github.com/k2-fsa/sherpa-onnx.git "$source_dir"
fi
git -C "$source_dir" fetch --depth 1 origin "$sherpa_commit"
git -C "$source_dir" checkout --detach "$sherpa_commit"

mkdir -p "$assets_dir"
models=(tokens.txt encoder-epoch-12-avg-2-chunk-16-left-64.onnx decoder-epoch-12-avg-2-chunk-16-left-64.onnx joiner-epoch-12-avg-2-chunk-16-left-64.onnx)
for file in "${models[@]}"; do
  if [[ ! -f "$output_dir/$file" ]]; then
    echo "missing model asset: $output_dir/$file; run scripts/fetch-voice-models.sh" >&2
    exit 3
  fi
  cp "$output_dir/$file" "$assets_dir/$file"
done

export SHERPA_ONNX_IS_USING_BUILD_WASM_SH=ON
build_dir="$source_dir/build-wasm-simd-kws"
cmake -S "$source_dir" -B "$build_dir" \
  -DCMAKE_INSTALL_PREFIX="$build_dir/install" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE="$EMSCRIPTEN/cmake/Modules/Platform/Emscripten.cmake" \
  -DSHERPA_ONNX_ENABLE_PYTHON=OFF \
  -DSHERPA_ONNX_ENABLE_TESTS=OFF \
  -DSHERPA_ONNX_ENABLE_CHECK=OFF \
  -DBUILD_SHARED_LIBS=OFF \
  -DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF \
  -DSHERPA_ONNX_ENABLE_JNI=OFF \
  -DSHERPA_ONNX_ENABLE_C_API=ON \
  -DSHERPA_ONNX_ENABLE_TTS=OFF \
  -DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF \
  -DSHERPA_ONNX_ENABLE_GPU=OFF \
  -DSHERPA_ONNX_ENABLE_WASM=ON \
  -DSHERPA_ONNX_ENABLE_WASM_KWS=ON \
  -DSHERPA_ONNX_ENABLE_BINARY=OFF \
  -DSHERPA_ONNX_LINK_LIBSTDCPP_STATICALLY=OFF
cmake --build "$build_dir" --parallel
cmake --install "$build_dir"

wasm_dir="$build_dir/install/bin/wasm"
runtime=(sherpa-onnx-kws.js sherpa-onnx-wasm-kws-main.js sherpa-onnx-wasm-kws-main.wasm sherpa-onnx-wasm-kws-main.data)
for file in "${runtime[@]}"; do
  if [[ ! -f "$wasm_dir/$file" ]]; then
    echo "build output missing: $wasm_dir/$file" >&2
    exit 4
  fi
  cp "$wasm_dir/$file" "$output_dir/$file"
done

# Emscripten 4 emits a resizable ArrayBuffer view when the browser supports
# memory64 helpers. Chrome's TextDecoder rejects that buffer during sherpa model
# initialization. Keep the same WASM memory and expose its ordinary fixed view.
runtime_js="$output_dir/sherpa-onnx-wasm-kws-main.js"
node - "$runtime_js" <<'NODE'
const fs = require('node:fs')
const path = process.argv[2]
const source = fs.readFileSync(path, 'utf8')
const generated = 'function getMemoryBuffer(){try{var b=wasmMemory.toResizableBuffer();return b}catch{}return wasmMemory.buffer}'
const compatible = 'function getMemoryBuffer(){return wasmMemory.buffer}'
if (!source.includes(generated) && !source.includes(compatible)) {
  throw new Error('unexpected Emscripten memory-buffer helper')
}
fs.writeFileSync(path, source.replace(generated, compatible))
NODE

node "$root/scripts/voice-assets.mjs"
