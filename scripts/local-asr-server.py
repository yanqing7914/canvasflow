#!/usr/bin/env python3
"""Local PCM16LE ASR adapter for CanvasFlow on Apple Silicon.

The service listens on loopback only. It downloads the selected MLX Whisper
model into the Hugging Face cache on first request and never forwards audio.
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
import sys

import mlx_whisper
import numpy as np


HOST = os.environ.get("LOCAL_ASR_HOST", "127.0.0.1")
PORT = int(os.environ.get("LOCAL_ASR_PORT", "8899"))
MODEL = os.environ.get("LOCAL_ASR_MODEL", "mlx-community/whisper-tiny")


class Handler(BaseHTTPRequestHandler):
    server_version = "CanvasFlowLocalASR/1.0"

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/health":
            self.send_json(200, {"ok": True, "model": MODEL, "local": True})
            return
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/transcribe":
            self.send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 30 * 1024 * 1024:
                raise ValueError("PCM body must be between 1 byte and 30 MiB")
            raw = self.rfile.read(length)
            samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
            if samples.size == 0:
                raise ValueError("PCM body is empty")
            result = mlx_whisper.transcribe(
                samples,
                path_or_hf_repo=MODEL,
                language="zh",
                task="transcribe",
                verbose=False,
                condition_on_previous_text=False,
            )
            text = str(result.get("text", "")).strip()
            segments = result.get("segments") or []
            logprobs = [float(segment["avg_logprob"]) for segment in segments if "avg_logprob" in segment]
            confidence = None
            if logprobs:
                confidence = max(0.0, min(1.0, sum(math.exp(value) for value in logprobs) / len(logprobs)))
            payload = {"text": text, "local": True}
            if confidence is not None:
                payload["confidence"] = confidence
            self.send_json(200, payload)
        except Exception as error:
            self.send_json(500, {"error": str(error), "local": True})

    def log_message(self, format, *args):
        print("[local-asr] " + (format % args), flush=True)


if __name__ == "__main__":
    print(f"CanvasFlow local ASR listening on http://{HOST}:{PORT} (model={MODEL})", flush=True)
    try:
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nCanvasFlow local ASR stopped", flush=True)
        sys.exit(0)
