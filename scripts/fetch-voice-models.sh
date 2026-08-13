#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
archive_url="https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2"
archive_sha="b2f7c89690dc8ce4c6ed6afeab7cd800c36ad1421fb6b6302b4a4b194cf7f35f"
archive_size="32654866"
vad_url="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"
vad_sha="9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6"
vad_size="643854"
cache_dir="${VOICE_MODEL_CACHE:-$root/.canvasflow/voice-downloads}"
mkdir -p "$cache_dir"
archive="$cache_dir/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2"
extract="$(mktemp -d "${TMPDIR:-/tmp}/canvasflow-kws.XXXXXX")"
trap 'rm -rf "$extract"' EXIT

fail_json() {
  local status="$1" code="$2" message="$3" exit_code="$4"
  node - "$status" "$code" "$message" "$exit_code" <<'NODE'
const [status, code, message, exitCode] = process.argv.slice(2)
console.log(JSON.stringify({ ok: false, status, exitCode: Number(exitCode), errors: [{ code, message }] }, null, 2))
NODE
  exit "$exit_code"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else echo "sha256sum or shasum is required" >&2; exit 1
  fi
}

download_verified() {
  local name="$1" url="$2" expected_sha="$3" expected_size="$4" out="$5"
  if [[ -f "$out" && "$(sha256_of "$out")" == "$expected_sha" && "$(wc -c < "$out" | tr -d ' ')" == "$expected_size" ]]; then
    return
  fi

  local partial="$out.part"
  if ! curl -fL -C - --retry 3 --connect-timeout 20 -o "$partial" "$url"; then
    rm -f -- "$partial"
    if ! curl -fL --retry 3 --connect-timeout 20 -o "$partial" "$url"; then
      fail_json download_failed DOWNLOAD_FAILED "$name could not be downloaded from its pinned URL" 6
    fi
  fi

  local actual_sha actual_size
  actual_sha="$(sha256_of "$partial")"
  actual_size="$(wc -c < "$partial" | tr -d ' ')"
  if [[ "$actual_sha" != "$expected_sha" || "$actual_size" != "$expected_size" ]]; then
    fail_json checksum_mismatch DOWNLOAD_CHECKSUM_MISMATCH "$name failed pinned SHA-256 or size verification" 4
  fi
  mv -f -- "$partial" "$out"
}

mkdir -p "$root/apps/demo/public/voice/kws" "$root/apps/demo/public/voice/models"
download_verified kws "$archive_url" "$archive_sha" "$archive_size" "$archive"
download_verified silero-vad "$vad_url" "$vad_sha" "$vad_size" "$root/apps/demo/public/voice/models/silero_vad.onnx"
if ! tar -xjf "$archive" -C "$extract"; then
  fail_json checksum_mismatch ARCHIVE_EXTRACTION_FAILED "verified KWS archive could not be extracted" 4
fi
archive_roots=("$extract"/*)
if [[ "${#archive_roots[@]}" -ne 1 || ! -d "${archive_roots[0]}" ]]; then
  fail_json missing ARCHIVE_LAYOUT_INVALID "KWS archive does not contain one model directory" 3
fi
archive_root="${archive_roots[0]}"
files=(tokens.txt encoder-epoch-12-avg-2-chunk-16-left-64.onnx decoder-epoch-12-avg-2-chunk-16-left-64.onnx joiner-epoch-12-avg-2-chunk-16-left-64.onnx)
for file in "${files[@]}"; do
  if [[ ! -f "$archive_root/$file" ]]; then
    fail_json missing ARCHIVE_FILE_MISSING "KWS archive is missing $file" 3
  fi
  cp "$archive_root/$file" "$root/apps/demo/public/voice/kws/$file"
done

node "$root/scripts/voice-assets.mjs" \
  --asset sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01 \
  --asset silero-vad
