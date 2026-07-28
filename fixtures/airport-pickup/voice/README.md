# Voice Fixtures

These samples provide deterministic input for the P0 voice fallback path. They
are fictional demo utterances, not production recordings or user data.

- WAV format: mono, 16-bit PCM, 16 kHz.
- `create-airport-pickup.wav`: primary task creation utterance.
- `flight-number.wav`: follow-up flight-number utterance.
- `noisy-create.wav`: reproducibly noise-augmented input that should require
  user confirmation before submission.
- `transcripts.json`: canonical transcript, confidence, and confirmation rules.

The frontend owns microphone capture, ASR, editing, and TTS. These files only
provide a stable offline fallback when browser speech services are unavailable.
