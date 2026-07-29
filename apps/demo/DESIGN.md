# Dynamic Trip Brief Design Rules

## Overview

**Creative North Star: "The Quiet Roadbook."**

Dynamic Trip Brief is a calm, production-car-inspired presentation for one
airport-pickup task. The driver should read it as one changing trip card, not
as a dashboard, a developer console, or a collection of interchangeable UI
widgets.

Each state answers, in this order:

1. What is happening now?
2. What is the one fact or number that matters most?
3. What can I do next?

The signature is the disciplined hierarchy of that single brief: phase identity
at the top, a clear current conclusion, only the facts supplied to support it,
and an action at the point of decision.

**Key Characteristics:**

- One centered white brief with quiet surrounding cabin space.
- The current component conclusion leads; supporting facts and actions follow.
- Color communicates a real action or state, never decoration or ambience.
- Voice remains an assistive utility, not a competing task panel.

**The One Brief Rule.** The surface must read as one evolving journey summary;
new regions earn their place only when they help answer the next driver question.

## Colors

| Role | Value | Use |
| --- | --- | --- |
| Cabin background | `#EEF1F4` | Page and surrounding space |
| Brief surface | `#FFFFFF` | Main Trip Brief and necessary surfaces |
| Ink | `#102033` | Titles, key facts, primary text |
| Secondary ink | `#667384` | Labels and supporting facts |
| Rule | `#DDE3EA` | Quiet dividers and borders |
| Action blue | `#246BFD` | Primary action, active route state, key ETA |
| Success green | `#2EAD63` | Confirmed and completed states |
| Warning amber | `#C77A18` | High-priority attention state |
| Critical red | `#C74646` | Failure, cancellation, unavailable state |

Use solid surfaces, shallow shadows, fine rules, and generous radii. Blue is
for an actionable or active fact, not general decoration. Green, amber, and red
carry state meaning only; high and critical states may use a restrained edge or
label, but never flash or pulse.

**The State-Only Color Rule.** Blue, green, amber, and red identify an action,
activity, success, attention, or failure; they never become a decorative theme.

## Typography

- Chinese UI text uses local fonts in this order: `HarmonyOS Sans SC`,
  `MiSans`, `Microsoft YaHei UI`, `sans-serif`.
- Times, percentages, distances, and revisions use `Bahnschrift`,
  `DIN Alternate`, `Cascadia Code`, `monospace`, with tabular numerals.
- At 1920 x 720, the semantic task title is approximately 48-62px; navigation
  ETA may reach 108-146px. Key reading copy is 18-22px, while compact labels
  are quieter. Primary actions are 72px high; header utilities are 48px high.
- `spec.title` is the only semantic page title (`h1`). When its current
  component supplies a more specific conclusion, retain that `h1` but style it
  as subdued trip context; do not generate a competing task title from state.
- Write plain, stable Chinese labels and verbs. Do not expose component names,
  schemas, fixture mode, providers, revisions, or other implementation terms
  in the task surface.
- A large number must have a clear label. Supporting facts stay visually quiet
  and may not compete with the current conclusion.
- On desktop, the Trip Brief keeps one stable outer frame while its legal
  content changes. Sparse states use a top conclusion and lower supporting
  anchor instead of changing the card height or inventing filler facts.

**The Conclusion-First Rule.** One visible conclusion leads each phase; the
semantic page title may provide context but must not compete with it.

## Layout

- The task surface is one centered white Trip Brief on a cool grey cabin
  background. It owns the brand, phase label, microphone, demo-control entry,
  semantic title, current content, and legal actions.
- The visible phase label is a private display mapping of `UISpec.phase`:
  `准备接机`, `准备出发`, `途中`, `即将到达`, `等待家人`, `家人已上车`,
  `行程结束`, or `行程已取消`. Never show the raw enum value to the driver.
- Normal renderer components are information sections inside the brief. Use
  spacing and quiet horizontal rules to separate them; do not place every
  section in an identical bordered card. Fallbacks, explicit alerts, and action
  groups may use a distinct surface when that improves comprehension.
- At 1920 x 720, the Trip Brief fills the useful viewport without looking
  unfinished and the page has no horizontal or vertical scroll. At 1024px and
  above, compress supporting facts before reducing the primary conclusion.
- Below 680px, the brief becomes a natural single-column flow and vertical
  scrolling is allowed. The controls drawer becomes a bottom sheet. Horizontal
  overflow is never allowed.

**The Fixed Frame Rule.** Opening the controls drawer or changing a phase may
change only the brief's content, never its desktop width or the reading order.

## Elevation & Depth

The cool-grey cabin is a quiet environmental field. The white Trip Brief earns
one shallow ambient lift; normal information regions remain flat and rely on
whitespace and fine rules. Only fallback, explicit alert, and necessary action
surfaces may use a stronger separation treatment.

**The Single Lift Rule.** Depth belongs to the journey brief, not to every fact
inside it; stacked card shadows turn a single task into a dashboard.

## Shapes

The main brief uses a generous rounded rectangle. Controls, inputs, and actions
use smaller, restrained corners with fine solid borders. Avoid global pill
labels, glass blur, neon, gradient buttons, decorative grids, ambient lighting,
and route rings.

## Components

- The renderer reads only the legal `UISpec`, component props, layout,
  presentation, and `UISpec.phase`. It must not read task state to reconstruct
  cross-component facts.
- Preserve the declared layout type, slot order, component whitelist, test data
  attributes, and action callback contract. Layout is data, not permission to
  reorder or invent content.
- `full` shows supplied explanation and secondary facts; `compact` reduces
  spacing for active driving; `minimal` retains the conclusion, key number or
  status, and necessary action. In particular, a failed or scheduled message
  must continue to show its send status in `minimal` density.
- Omit unavailable data instead of rendering empty labels, invented values, or
  reference-art placeholders. The demo never fabricates maps, vehicle speed,
  additional battery values, charging stations, return navigation, passenger
  events, or preference changes.
- Unknown, missing, malformed, or offline components render a human-facing
  fallback: `这项信息暂时无法显示`. Do not expose an ID, component type, schema
  failure, or "safe fallback" engineering language.
- An interaction forwards only its declared `action.id`; all authorization,
  confirmation, tool calls, and side effects remain outside the renderer.

### Trip Brief Components

Each component has its own editorial shape rather than a shared "icon, eyebrow,
title, card" template:

- `status-banner` and `alert`: large status sentence, then one concise recovery
  or next-step instruction.
- `pickup-overview`: pickup purpose first, then supplied passenger, flight,
  airport, and terminal facts.
- `flight-status`: flight number and status lead; estimated arrival is the main
  number; terminal and baggage remain secondary. The original schedule is a
  comparison and may disappear in `minimal` density without hiding the estimate.
- `navigation-summary`: destination and ETA form the visual center; supplied
  distance and arrival battery form a quiet lower information band. Without a
  legal position/progress fact, its blue route mark means only “navigation is
  active”; it must not imply unavailable map progress.
- `charging-recommendation`: recommended charging duration is the conclusion;
  the current-to-estimated battery relationship and reason support it.
- `passenger-status`: landed, waiting, or onboard status is primary; enlarge a
  supplied pickup point or next action.
- `message-preview`: contact, message content, send status, and legal action
  stay together as one readable message block.
- `cabin-profile`: temperature, airflow, and media are parallel facts; explain
  applied, remembered, and reversible behavior with copy, not decoration.
- `task-progress`: show the latest five real phases as a route-like progress
  line. Completion closes the story; no unsupported progress is implied.

### Interactions, Voice, And Motion

- The controls drawer is a separate demo surface. It starts closed and overlays
  the right edge of the page without changing the Trip Brief width. Engineering
  metadata stays there, never in the driver-facing brief.
- Put actions immediately after the conclusion they affect. A single primary
  action fills the action area; multiple actions make their primary/secondary
  relationship apparent without turning into pills or toolbar chrome.
- The microphone and the keyboard are small, non-blocking utility entries that sit
  together in the header. Voice status and the editable transcript/text fallback
  appear between the header and the journey content when a transcript needs
  review, voice cannot carry the turn, or the driver asks for the keyboard;
  neither creates a second trip narrative.
- Its `idle`, `listening`, `transcribing`, `submitting`, `speaking`, `error`,
  and `unavailable` states use static text, icon, and color only. `transcribing`
  and `speaking` share the blue accent because both mean the assistant holds the
  turn; `submitting` uses amber, `error` uses red.
- A recognised utterance appears in an editable field before it is sent, so a
  misrecognition is corrected rather than acted on. The same field is the text
  fallback: it is present whenever voice cannot carry the turn, which keeps a
  voice failure from ever leaving the driver without an input path.
- Why the field opened is what it means, so the reason carries the colour: a
  transcript awaiting confirmation takes the blue that means the assistant holds
  the turn, a failed or unavailable voice path takes red, and a keyboard the
  driver simply asked for stays neutral. A keyboard nothing depends on can be
  dismissed from the header; one the turn needs cannot, and says so.
- Listening, submitting, and playback are announced through one polite live
  region rather than motion or a moving meter.
- Every button is semantic, keyboard reachable, touch friendly, and has a
  clear visible focus ring. Toggle and drawer controls expose pressed or
  expanded state. The drawer traps focus while open, closes with Escape, and
  restores focus to its trigger.
- A phase update may use one 180-220ms fade with a slight vertical settle. It
  replays when the phase changes, never continuously. `prefers-reduced-motion:
  reduce` reduces animation and transition duration to effectively zero.
- The thin blue route rule is the one structural signature. It connects a real
  current phase marker to the next actionable fact only when the progress data
  provides one; otherwise it ends cleanly at the active marker.

## Do's and Don'ts

### Do:

- **Do** keep the current legal component conclusion ahead of supporting facts.
- **Do** preserve `spec.title` as the sole semantic page title, even when its
  visual role becomes trip context.
- **Do** use the editable text path whenever voice cannot complete a turn.
- **Do** let the drawer overlay the brief and restore focus to its trigger.
- **Do** use one brief-level phase transition and honor reduced motion.

### Don't:

- **Don't** construct maps, locations, distances, battery readings, passenger
  events, or preference changes not present in the `UISpec`.
- **Don't** show implementation vocabulary, raw phases, component types,
  fixture mode, schemas, providers, or revisions on the driver-facing surface.
- **Don't** make voice an always-on listener, an autonomous task decision-maker,
  or the only available input path.
- **Don't** turn each component into a floating dashboard tile or add glass,
  neon, decorative grids, route rings, or gradient controls.
