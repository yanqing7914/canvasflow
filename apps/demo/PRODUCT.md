# CanvasFlow Demo Product Contract

## Purpose

The demo is a cabin display for one airport-pickup task. Its job is to help a
driver understand the current situation and choose the next safe action at a
glance. It is a fixture player for the competition demo, not a production
vehicle service.

## Brand

The product name is **pilotflow** — one word, all lowercase. It is not
`PilotFlow`, `Pilotflow`, or `PILOTFLOW`, and it takes no subtitle or tagline.
The previous name was `carHer`, camel-cased; the owner renamed it on 2026-08-03
and chose the all-lowercase form deliberately, so the case change is not a typo
to be corrected.

The name is also the hands-free wake phrase planned for P1: the team handbook's
`你好 carHer` now reads `你好 pilotflow`. Wake-word detection is not implemented
in this round (there is no KWS code in the repository), so nothing enforces the
phrase today — it is recorded here so a later P1 implementation does not
resurrect the old name from an out-of-date document.

The name appears in exactly four places:

| Site | What it is |
| --- | --- |
| `apps/demo/src/App.tsx` `.brand-wordmark` | The visible header wordmark |
| `apps/demo/src/App.tsx` brand lockup `aria-label` | Accessible name of the header link |
| `apps/demo/index.html` `<title>` | Browser tab and window title |
| `tests/e2e/app.spec.ts` focus-order assertion | Guards the header tab order, and now the name |

A rename must touch all four. Before this record existed the string lived only
in the code and one e2e assertion, with no written source for where it came
from — which is how it entered the repository without review in the first place.

## Product facts

- The only business source of truth is the legal `UISpec` produced by the
  existing Composer. The view must not rebuild facts from task state.
- The public schema, Composer, Agent, tools, fixtures, action IDs, and business
  state machine are out of scope for this UI redesign.
- The main fixture is the shared airport-pickup timeline in
  `fixtures/airport-pickup/timelines/main-flow.json`.
- Advisory timeline entries are informational sensor observations. They must
  not advance the business phase or count as a player step.
- The non-advisory flow covers collecting information, preparing, driving to
  the airport, approaching, waiting for passengers, returning home, and
  completing the trip. Cancellation remains a supported terminal state.
- The demo uses fictional fixture data. It does not connect to live flight,
  map, or vehicle services, and it does not use a wake word. Speech recognition
  and playback use the browser's own Web Speech API, with no server of ours.
- A renderer action emits only the declared `action.id`. Agent or tool code
  owns authorization, confirmation, side effects, and parameter construction.
- Missing, unknown, malformed, or offline UI data must produce a useful
  placeholder or fallback card. It must never blank the page.
- The microphone runs a real voice turn: press to listen, review the recognised
  text in an editable field, send, then hear a short spoken acknowledgement.
  Pressing the microphone during playback barges in and starts a new turn.
- The voice core produces a transcript and nothing more. Task interpretation
  belongs at the Agent boundary, and a transcript goes there unread: the browser
  sends the words and a `source` marker, never its own reading of them. A
  misrecognition can therefore never rewrite the trip on its own.
- Text and voice share one input path, so voice never gets a private route into
  the task. `source` only tells the Gateway where the words came from.
- The keyboard is on demand, not a permanent input row. It appears when the turn
  needs it — a transcript is waiting to be confirmed, or voice cannot carry this
  turn — and when the driver asks for it. When voice is carrying the turn, the
  journey content keeps the space instead.
- The keyboard closes only when nothing depends on it. A transcript awaiting
  confirmation, a failed voice turn, and a browser without speech recognition all
  hold it open, and the 文字 entry reports itself as unable to dismiss it rather
  than silently refusing. Voice is never the only way in, so that entry is
  reachable in every state the microphone does not own.
- The text path closes entirely while the microphone is capturing or its
  transcript is in flight: during capture the field would still hold the previous
  turn's words, and during submission those words have already been sent once.
- Every voice failure (no API, insecure context, denied microphone, nothing
  heard, engine error, timeout) states what happened and opens the text field.
  Voice is never the only way to continue.
- Voice activity detection and an on-device wake word are P1. This round has no
  always-on microphone and ships no model artifacts.

## Driver-facing questions

Every screen should answer these questions in order:

1. What is happening now?
2. What is the most important number or status?
3. What can I do next?

Engineering metadata (raw phase, task id, task revision, UI revision, density,
priority, component type, and effect receipts) belongs in the demo controls
drawer, never in the driver-facing task surface. The driver reads a phase as
`准备接机` / `准备出发` / `途中` / `即将到达` / `等待家人` / `家人已上车` /
`行程结束` / `行程已取消`; the enum itself stays in the drawer.

## Supported stage story

The fixture should remain readable as one continuous story:

- **Prepare:** confirm the pickup and the flight before leaving.
- **En route:** keep route, arrival, and charging guidance legible while
  driving.
- **Approach / wait:** make the airport arrival and passenger status obvious.
- **Return / finish:** show the return state, cabin preference result, and a
  calm completion confirmation.

The renderer may only display fields supplied by the current `UISpec`. It must
not invent arrival times, distances, battery values, passenger events, or
preference changes from a reference image.

## Interaction rules

- Controls use plain, stable verbs such as `推进下一事件`, `确认`, `重试发送`,
  and `保存偏好`.
- Every actionable control is keyboard reachable, has a visible focus state,
  and is at least touch-friendly in the 1920 x 720 presentation viewport.
- The controls drawer is closed by default. Opening it overlays the task
  surface; it must not resize or reorder the driver-facing content.
- A terminal task disables fixture advancement while leaving any valid
  confirmation or retry action available.
- Voice is a utility entry, not a shortcut around the task surface: a voice turn
  reaches the task only through the Agent API, exactly like text, while declared
  `UISpec` actions retain their existing Agent-owned confirmation path.

## Non-goals

This round does not add component types, alter schema validation, change the
Composer's phase decisions, integrate external providers, or implement maps,
navigation control, or vehicle control.

Voice ships as a browser-only recognition and playback path. It does not add
voice activity detection, an on-device wake word, an always-on microphone, or any
server-side speech service, and it does not move task understanding into the
frontend: the transcript goes to the Agent API unread.
