# Airport Pickup Fixtures

Each JSON file is a self-contained contract fixture with the input event, initial and expected task state, trusted tool results, expected UI projection, and expected effects. All fixtures use fictional IDs and `fixture` mode.

The files are intentionally explicit so Agent, tools, and UI tests can consume the same scenario without relying on screenshots or private data.

`timelines/` contains replayable demo timelines (ordered events plus expected phase/revision per step) that drive the 5-minute demo and the timeline replay tests. Steps marked `advisory` are sensor-only events that must not change task facts; `statePatch` captures planner/tool writes that are not carried by the event itself.

Exception fixtures (`flight-delayed`, `flight-cancelled`, `provider-timeout`, `invalid-ui-spec`) cover delay/cancel/terminal-change and degradation paths. Deterministic timeout triggers: flight `MU0000`, destination id `destination-timeout`. Congestion alternates live in `packages/tools` route data (`route-airport-avoid-hw-001`, `route-airport-bypass-001`).
