# Voice Fixtures

These samples provide deterministic input for the P0 voice fallback path. They
are fictional demo utterances, not production recordings or user data.

- WAV format: mono, 16-bit PCM, 16 kHz.
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
- `transcripts.json`: canonical transcript, confidence, and confirmation rules.

The frontend owns microphone capture, ASR, editing, and TTS. These files only
provide a stable offline fallback when browser speech services are unavailable.
Samples are enabled only when their matching demo context is visible, so a
state-dependent utterance cannot silently run in the wrong phase.
