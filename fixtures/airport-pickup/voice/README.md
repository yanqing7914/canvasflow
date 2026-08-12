# Voice Fixtures

The browser's natural speech path is the primary customer experience. These 27
fictional recordings provide deterministic demo replay when microphone access,
Web Speech, audio playback, or network-backed recognition is unavailable. They
are not ASR results, production recordings, or user data: `transcripts.json` is
the canonical text/confidence payload and each WAV is presentation audio only.

## Catalog

- Task creation: `create-airport-pickup.wav`, `noisy-create.wav`.
- Airport and flight selection: `choose-hongqiao.wav`,
  `select-first-flight.wav`, `select-third-flight.wav`, `refresh-flights.wav`,
  `flight-number.wav`.
- En-route information: `check-weather.wav`, `check-calendar.wav`,
  `check-flight-detail.wav`, `check-vehicle-status.wav`.
- Navigation controls: `start-navigation.wav`, `speed-up.wav`,
  `speed-down.wav`, `hide-hud.wav`, `show-hud.wav`.
- Advisories: `send-weather-reminder.wav`, `dismiss-weather-advisory.wav`,
  `keep-calendar-plan.wav`.
- Arrival and return: `passengers-onboard.wav`, `request-return.wav`,
  `start-return.wav`.
- Trip reset: `reset-trip.wav`, `confirm-reset.wav`, `cancel-reset.wav`.
- Memory confirmation: `save-preferences.wav`, `reject-preferences.wav`.

Every state-dependent sample is enabled only when its matching task phase,
cockpit window, registered action, or pending confirmation is present. Replay
still uses the Agent API paths used by normal input; it never mutates trip state
directly in the frontend. The low-confidence `noisy-create.wav` sample must stop
for explicit transcript confirmation.

## Audio format and generation

All WAV files are mono, 16-bit PCM at 16 kHz. The synthetic recordings were
generated on macOS with the built-in Tingting voice and converted with
`afconvert`:

```bash
say -v Tingting -r 185 -o sample.aiff "<fixture text>"
/usr/bin/afconvert -f WAVE -d LEI16@16000 -c 1 sample.aiff sample.wav
```

When adding or replacing a sample, update `transcripts.json` in the same change.
Tests require a one-to-one mapping between catalog entries and shipped WAVs and
verify the RIFF/WAVE header, channel count, sample rate, bit depth, and maximum
duration. Do not add real customer speech, copied production audio, or any
recording containing private information.
