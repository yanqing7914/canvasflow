# Voice Fixtures

These samples provide deterministic input for the P0 voice fallback path. They
are fictional demo utterances, not production recordings or user data.

- WAV format: mono, 16-bit PCM, 16 kHz.
- Source: fictional phrases synthesized locally with the macOS `say` command
  and the built-in `Tingting` voice by `scripts/generate-voice-fixtures.mjs`;
  no production recording, user audio, or external speech service is used.
- `transcripts.json` is the browser-demo catalog consumed by the replay
  drawer: canonical transcript, confidence, and confirmation rules per sample.
- `manifest.json` is the broader transcription-provider contract. It records
  each reviewed file's SHA-256, duration, deterministic result or error, and
  optional partial transcript sequence.
- `create-airport-pickup.wav`: primary task creation utterance.
- `select-first-flight.wav`: chooses the first row on the visible arrivals board.
- `flight-number.wav`: follow-up flight-number utterance.
- `noisy-create.wav`: reproducibly noise-augmented input that should require
  user confirmation before submission.
- `check-weather.wav`: asks for arrival-time weather during trip preparation.
- `start-navigation.wav`: invokes the currently registered navigation action.
- `send-weather-reminder.wav`: answers the active rain advisory and opens the
  message confirmation preview.
- `dismiss-weather-advisory.wav`: retires the active rain advisory without a send.

The provider catalog additionally covers a complete request, a missing flight
number, background noise, no speech, a fixed misrecognition, timeout, short
noise, a truncated utterance, and spoken flight-number digits. Fixture
transcription resolves an upload by its reviewed SHA-256; filenames are never
trusted as recognition results, and unknown audio fails explicitly.

The frontend owns microphone capture, ASR, editing, and TTS. These files only
provide stable offline paths when browser speech services are unavailable.
Replay samples are enabled only when their matching demo context is visible,
so a state-dependent utterance cannot silently run in the wrong phase. The
browser replay catalog and provider catalog remain separate because they serve
different surfaces, but tests validate every entry and referenced WAV.
