# Voice Fixtures

These samples provide deterministic input for the P0 voice fallback path. They
are fictional demo utterances, not production recordings or user data.

- WAV format: mono, 16-bit PCM, 16 kHz.
- Source: fictional phrases synthesized locally with the macOS `say` command
  and the built-in `Tingting` voice by `scripts/generate-voice-fixtures.mjs`;
  no production recording, user audio, or external speech service is used.
- `transcripts.json` is the small browser-demo catalog consumed by the replay
  drawer. It intentionally contains only the three samples useful on stage.
- `manifest.json` is the broader transcription-provider contract. It records
  each reviewed file's SHA-256, duration, deterministic result or error, and
  optional partial transcript sequence.
- `create-airport-pickup.wav`: primary task creation utterance.
- `flight-number.wav`: follow-up flight-number utterance.
- `noisy-create.wav`: reproducibly noise-augmented input that should require
  user confirmation before submission.

The provider catalog additionally covers a complete request, a missing flight
number, background noise, no speech, a fixed misrecognition, timeout, short
noise, a truncated utterance, and spoken flight-number digits. Fixture
transcription resolves an upload by its reviewed SHA-256; filenames are never
trusted as recognition results, and unknown audio fails explicitly.

The frontend owns microphone capture, ASR, editing, and TTS. These files only
provide stable offline paths when browser speech services are unavailable. The
browser replay catalog and provider catalog remain separate because they serve
different surfaces, but tests validate every entry and referenced WAV.
