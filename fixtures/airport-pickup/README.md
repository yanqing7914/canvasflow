# Airport Pickup Fixtures

Each JSON file is a self-contained contract fixture with the input event, initial and expected task state, trusted tool results, expected UI projection, and expected effects. All fixtures use fictional IDs and `fixture` mode.

The files are intentionally explicit so Agent, tools, and UI tests can consume the same scenario without relying on screenshots or private data.

`timelines/` contains replayable demo timelines (ordered events plus expected phase/revision per step) that drive the 5-minute demo and the timeline replay tests. Steps marked `advisory` are sensor-only events that must not change task facts; `statePatch` captures planner/tool writes that are not carried by the event itself.

Exception fixtures (`flight-delayed`, `flight-cancelled`, `provider-timeout`, `invalid-ui-spec`) cover delay/cancel/terminal-change and degradation paths. Deterministic timeout triggers: flight `MU0000`, destination id `destination-timeout`. Congestion alternates live in `packages/tools` route data (`route-airport-avoid-hw-001`, `route-airport-bypass-001`).

`route-sketch/progress.json` stages the discrete trip progress the offline route
sketch draws: one authored value per matching task state, listed in trip order,
last match winning. It is not a scenario fixture, so it lives outside the
catalog at the directory root; the UI never accumulates or animates a value of
its own. Coordinates for the sketch itself stay in `packages/tools` route data.

`voice/` contains offline speech-input fallback assets. `timelines/` also
contains short replay scenarios for timeout, delay, cancellation, congestion
rerouting, message failure, and charging completion; these are intended for the
demo scenario picker and provider/tool integration tests.

Consumers should import `demoScenarioCatalog`, `getDemoTimeline`,
`demoVehicleSnapshots`, and `voiceFallbackManifest` from
`@canvasflow/tools/demo-fixtures` instead of reading repository paths directly.
Keeping this as a subpath avoids loading all scenario JSON in Provider
consumers that do not render a fixture player. WAV files remain repository
assets owned by the frontend's capture/ASR fallback integration; the manifest
is the stable handoff contract.
