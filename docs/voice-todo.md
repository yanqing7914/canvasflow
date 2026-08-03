# Voice Delivery TODO

This checklist tracks the demo voice path separately from production speech services.

## Demo-ready P0

- [x] Browser Web Speech capture with interim/final transcript handling.
- [x] Editable transcript confirmation through the shared Agent input path.
- [x] Voice source/confidence metadata at the Agent API boundary.
- [x] Browser TTS acknowledgement and microphone barge-in.
- [x] Text fallback for unsupported, insecure, denied, empty, failed, and timed-out turns.
- [x] Deterministic WAV fixtures: standard task, flight number, and reproducible noise sample.
- [x] Schema-validated fixed transcripts with confidence and confirmation metadata.
- [x] Demo controls for playing WAV files and loading their fixed transcripts without Web Speech.
- [x] Low-confidence fixture warning before submission.
- [ ] Manual acceptance in Chrome: microphone permission, Mandarin recognition, TTS, barge-in, and all three WAV fixtures.
- [ ] Capture a short voice happy-path recording and a noisy fallback recording for the release PR.

## Production follow-up

- [ ] Select a production ASR boundary: on-device engine or reviewed server adapter.
- [ ] Add streaming audio capture/upload only after privacy, retention, and credential review.
- [ ] Add VAD for natural end-of-utterance detection.
- [ ] Evaluate an on-device wake word; do not enable an always-on microphone by default.
- [ ] Add device/locale selection and a reviewed TTS fallback when browser synthesis is unavailable.
- [ ] Add latency, recognition failure, correction, cancellation, and fallback telemetry without storing raw audio by default.
- [ ] Test cabin noise, Bluetooth routing, permission recovery, offline mode, and mobile browser behavior on target hardware.
