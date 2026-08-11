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

- One centered brief with quiet surrounding cabin space.
- The current component conclusion leads; supporting facts and actions follow.
- Color communicates a real action or state, never decoration or ambience.
- Voice remains an assistive utility, not a competing task panel.
- The cabin follows the car's own light condition, not the desktop's theme.

**The One Brief Rule.** The surface must read as one evolving journey summary;
new regions earn their place only when they help answer the next driver question.

A route map is the one case where the brief stops being a centered card: the
map takes the surface and the brief's cards become a single rail floating over
it. That is still one brief — one ordered reading, one conclusion, one action
area — laid over its own subject rather than beside it. It is a change of
ground, not a second narrative, and every condition it depends on is named
under Layout and Shapes.

## Colors

The cockpit ships two cabins. `UISpec.presentation.theme` carries which one,
and the renderer applies it to the whole driver-facing surface rather than to
the generated cards alone: leaving a white shell around a dark route builds the
brightest possible frame at the exact moment the cabin should dim.

| Role | Day | Night | Use |
| --- | --- | --- | --- |
| Cabin background | `#edf0f4` | `#0c1015` | Page and surrounding space |
| Brief surface | `#ffffff` | `#141a22` | Main Trip Brief and necessary surfaces |
| Ink | `#102033` | `#e8edf4` | Titles, key facts, primary text |
| Secondary ink | `#667384` | `#94a2b3` | Labels and supporting facts |
| Rule | `#dde3ea` | `#2a333f` | Quiet dividers and borders |
| Action blue | `#246bfd` | `#6ea2ff` | Primary action, active route state, key ETA |
| Success green | `#2ead63` | `#59d18d` | Confirmed and completed states |
| Warning amber | `#c77a18` | `#e5a54a` | High-priority attention state |
| Critical red | `#c74646` | `#f28b8b` | Failure, cancellation, unavailable state |

The state hues move between cabins instead of staying fixed, and they move for
a measured reason rather than a stylistic one. Day blue at `#246bfd` is 3.83:1
on the night cabin and day red at `#c74646` is 3.66:1 — both below AA as text,
on the one screen where a red carries meaning. Each night variant is the same
hue lifted until it clears 6:1 on its own panel, so blue still means blue and
red still means red; only their brightness moves.

Use solid surfaces, shallow shadows, fine rules, and generous radii. Blue is
for an actionable or active fact, not general decoration. Green, amber, and red
carry state meaning only; high and critical states may use a restrained edge or
label, but never flash or pulse.

Anything painted inside the frame — panels, markers, controls, the knockout
that punches the hollow centre out of a route stop — needs a value in both
cabins. A light-only hex literal is the failure mode here: it survives review
because it looks correct by day, and turns into a daylight artefact at night.

**The State-Only Color Rule.** Blue, green, amber, and red identify an action,
activity, success, attention, or failure; they never become a decorative theme.

**The Two Cabins Rule.** The theme is task data, not a user setting. The Agent
derives it from the vehicle's reported light condition and sends it in the
`UISpec`; the surface never reads `prefers-color-scheme`, because the cabin
follows the trip rather than a desktop preference set last week.

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

- The task surface is one centered Trip Brief on its cabin background. It owns
  the brand, phase label, microphone, keyboard and demo-control entries,
  semantic title, current content, and legal actions.
- The visible phase label is a private display mapping of `UISpec.phase`:
  `准备接机`, `准备出发`, `途中`, `即将到达`, `等待家人`, `家人已上车`,
  `行程结束`, or `行程已取消`. Never show the raw enum value to the driver.
- Normal renderer components are information sections inside the brief. Use
  spacing and quiet horizontal rules to separate them; do not place every
  section in an identical bordered card. Fallbacks, explicit alerts, and action
  groups may use a distinct surface when that improves comprehension.
- `UISpec.layout` declares one of `stack`, `row`, `column`, `split`, or
  `focus`. The renderer honours the declared type and slot order; a layout is
  data describing how the brief reads, never permission to reorder or invent
  content.
- At 1920 x 720, the Trip Brief fills the useful viewport without looking
  unfinished and the page has no horizontal or vertical scroll. At 1024px and
  above, compress supporting facts before reducing the primary conclusion.
- Transient status text lives inside a row that is already reserved, never in a
  row of its own. The frame is a fixed height and the journey content takes
  whatever is left, so a line that appears only in some states silently steals
  space from the content in exactly those states — and a state that used to be
  rare can stop being rare. The voice status is why this rule is written down: as
  its own row it cost the content 24px, which was invisible until the Agent began
  speaking on ordinary turns and pushed the brief past the fold. The header
  reserves 68px whether or not it has status text, so it is the right host.
- Below 680px, the brief becomes a natural single-column flow and vertical
  scrolling is allowed. The controls drawer becomes a bottom sheet. Horizontal
  overflow is never allowed.

### The Route Map Takeover

When a `split` layout carries a `route-map`, the two columns collapse onto one
cell: the map fills it and the secondary slot floats over the map as a single
rail. This is the only takeover in the design, and it is legal only under every
condition below.

- **One card in the rail.** The takeover paints a card, so a second card in an
  overlaid rail would be transparent, square-cornered text sitting straight on
  the map. Every rule that participates in the collapse carries the same
  single-card guard; a rail that can hold two cards must not collapse at all.
- **The map stays usable.** The slot turns pointer events off so the basemap
  behind the rail stays draggable, and takes them back at the component rather
  than at the card — a card's buttons are its siblings inside the component, so
  restoring them on the card alone would leave every button beside it dead
  while still looking live.
- **The caption clears the rail by the rail's own width.** Nothing more, which
  would eat into the progress caption for no reason, and nothing less, which
  would put the caption under the panel.

**The Fixed Frame Rule.** Opening the controls drawer or changing a phase may
change only the brief's content, never its desktop width or the reading order.
The route map takeover is the single exception, and it is driven by the spec's
own layout rather than by an interaction.

## Elevation & Depth

The cabin is a quiet environmental field. The Trip Brief earns one shallow
ambient lift; normal information regions remain flat and rely on whitespace and
fine rules. Only fallback, explicit alert, and necessary action surfaces may
use a stronger separation treatment.

The floating navigation panel earns the one further lift in the design, because
it is the one surface with something genuinely behind it. Its separation is
carried by the theme: by day a hairline of the panel's own light, at night a
shadow, because the same white edge that reads as a hairline on a light basemap
would ring the panel in a bright frame against a dark one.

**The Single Lift Rule.** Depth belongs to the journey brief, not to every fact
inside it; stacked card shadows turn a single task into a dashboard. A panel
floating over a live map is depth that reports a real relationship; a shadow
under a fact that sits on the brief is not.

## Shapes

The main brief uses a generous rounded rectangle. Controls, inputs, and actions
use smaller, restrained corners with fine solid borders. Avoid global pill
labels, neon, gradient buttons, decorative grids, ambient lighting, and route
rings.

### Glass

Translucency is legal in exactly one place: the navigation panel floating over
the basemap, under the Route Map Takeover's conditions. It is there because the
panel has to sit on the map without hiding it, which is a relationship no solid
surface can express. Everywhere else, glass is the decoration this design
rejects.

Where it is legal, it is a readability budget rather than a finish:

- **The alpha is a contrast floor, not a taste setting.** Nothing in the app
  can know what the basemap puts behind any given pixel — a tunnel, a park, a
  dark satellite tile — so the only guarantee available is the worst case, and
  it is a different case per cabin. Light glass is white, so it composites
  darkest over a black backdrop. Dark glass inverts the argument: its near-white
  text is at risk when the panel composites *bright*, over white. More alpha is
  more contrast in both cabins, for opposite reasons.
- **Every text token clears WCAG AAA 7:1 against its own worst case**, not the
  AA 4.5:1 floor. A driver reads this at a glance, at arm's length, over a
  basemap that is moving; 4.5:1 is a pass mark rather than a comfortable one.
  This is why the panel's small type needs its own token — secondary ink cannot
  reach even AA over anything a panel showing the map through it can offer.
- **The blur contributes nothing to the floor.** Where `backdrop-filter` is
  unavailable, or the driver has asked for reduced transparency, the panel
  falls back to a solid fill that may never be more transparent than the panel
  it replaces.

**The Earned Translucency Rule.** Glass is permitted only where something real
is behind it and the worst-case contrast is computed rather than eyeballed.
Lowering an alpha for a prettier effect is a readability regression, and the
suite is written to fail on it rather than let it ship.

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
  reference-art placeholders. The demo never fabricates vehicle speed,
  additional battery values, charging stations, return navigation, passenger
  events, or preference changes.
- The route map is drawn, not claimed. Every waypoint and polyline point comes
  from the geometry the composer attached; the renderer normalizes that set into
  its own view box, so the drawing shows the shape of a supplied route and never
  asserts geographic accuracy, live positioning, or GIS data. A map whose
  geometry is missing or unusable drops the whole component and takes the
  per-component fallback — a card without a sketch still carries its destination
  and ETA, but a map without geometry is an empty box.
- Cards that answer from an outside source carry their provenance. `live`,
  `cached`, and `fixture` are the three honest answers, and the card states
  which one it is rather than letting a fixture reading pass as a current one.
  A demo may degrade; it may not misrepresent.
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
- `route-map`: the destination names the map and the route is its content. The
  supplied `mode` is a view intent — whether the driver needs the whole trip or
  the part they are on — and how that becomes a zoom, a pitch, or a bearing is
  the renderer's business alone. Markers keep their three roles legible at a
  glance: origin filled, vias small and hollow, destination ringed.
- `flight-choices`: an arrivals board the driver picks from, so every row leads
  with its clock time and each row's action is its own control. A revised time
  says which way it moved: `later` is toned as a caution, `earlier` stays plain
  fact. An early arrival is news, not a warning, and an amber figure that means
  "good" teaches the driver to ignore amber.
- `departure-plan`: the departure time is the conclusion; what it is timed
  against, the drive, and the buffer support it. State the buffer rather than
  folding it into the time — a driver who wants to cut it finer can only do
  that if they can see what was set aside for them.
- `weather-card`: place and moment label the reading, temperature is the main
  number, and one pickup-relevant advisory follows when the weather needs one.
  Wind and precipitation stay secondary and disappear before the number does.
- `schedule-card`: the day it answers for, then the remaining events in time
  order. The card is a glance, so the tail belongs to a count of what was cut
  rather than to more rows; a day with nothing left says so in words.
- `schedule-strip`: task milestones and calendar events on one ordered band,
  with their provenance kept apart — solid markers for the task, hollow for the
  calendar — and an at-risk mark for a calendar entry the projected timing may
  miss. Deliberately no "now" marker: the fixture timeline and the wall clock
  disagree, and a clock the brief cannot honor is worse than none.

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
- **Do** give every painted value a reading in both cabins.
- **Do** state a card's freshness when it answers from an outside source.

### Don't:

- **Don't** construct locations, distances, battery readings, passenger events,
  or preference changes not present in the `UISpec`, or let a drawn route imply
  geographic accuracy or live positioning.
- **Don't** show implementation vocabulary, raw phases, component types,
  fixture mode, schemas, providers, or revisions on the driver-facing surface.
- **Don't** make voice an always-on listener, an autonomous task decision-maker,
  or the only available input path.
- **Don't** turn each component into a floating dashboard tile, or use glass
  anywhere but the navigation panel over the basemap. Neon, decorative grids,
  route rings, and gradient controls stay out entirely.
- **Don't** lower a glass alpha, or move in-panel type onto a token that was
  not measured against the panel's worst-case backdrop.
- **Don't** read `prefers-color-scheme`; the cabin follows the car.

