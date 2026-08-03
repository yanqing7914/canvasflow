# Third-Party Notices

This file records what this repository owes to other people's work: the packages it
depends on, the one project whose code influenced ours, and the projects that were
evaluated and not used. It is a record of fact and attribution, not a license grant.

CanvasFlow itself carries **no license** — see [Unresolved](#unresolved) at the end.
Every license statement below was verified against the upstream repository on
**2026-08-03** through the GitHub license API (which reads the repository's own
`LICENSE` file); the knowledge base's own claims were not taken as the source.

## 1. Bundled and depended-upon code

No third-party source is vendored into this repository. Nothing under `packages/`
or `apps/` is a copy, fork, or bundle of another project's tree.

The shipped browser runtime has three third-party dependencies:

| Package | Declared range (installed) | License | Verified from |
|---|---|---|---|
| `react` | `^19.1.0` (19.2.7) | MIT | https://github.com/react/react/blob/main/LICENSE |
| `react-dom` | `^19.1.0` (19.2.7) | MIT | https://github.com/react/react/blob/main/LICENSE |
| `zod` | `^4.0.5` (4.4.3) | MIT | https://github.com/colinhacks/zod/blob/main/LICENSE |

`apps/demo/package.json` also declares `vite`, `@vitejs/plugin-react`, and `tsx`
under `dependencies`; they are build and dev-server tooling, not part of the
browser bundle's third-party surface. Development-only dependencies (TypeScript,
ESLint, Vitest, Playwright and their transitive trees) are not enumerated here:
this file is about attribution for what the project uses and borrows, and a
generated full-tree dependency license inventory would be a different artifact
with a different purpose.

The only binary assets in the tree are the three voice fixtures
(`fixtures/airport-pickup/voice/*.wav`, mono 16-bit PCM); every other tracked file
is text authored here. Their own README
describes them as fictional demo utterances rather than production recordings or
user data, and no external corpus, voice talent, or synthesis service is named
anywhere in the repository. Nothing here contradicts that, but it is a claim read
off that README rather than a provenance this file independently verified — if
those recordings were produced by a third-party service, whatever that service's
terms require would belong in this section.

## 2. Code influenced by cockpit-agent

**[SuperdeMan/cockpit-agent](https://github.com/SuperdeMan/cockpit-agent)** —
Apache License 2.0, `Copyright 2026 SuperdeMan`.
License verified at https://github.com/SuperdeMan/cockpit-agent/blob/main/LICENSE
on 2026-08-03. The upstream repository has a `LICENSE` file and **no `NOTICE`
file**; the files discussed below carry no per-file copyright or attribution
headers.

Two files in `packages/voice` say in their own comments that they draw on this
project. Both were read in full against the upstream sources before writing this
section. The upstream files compared were, at the SHAs current on 2026-08-03:

- `hmi/src/voiceLoop.mjs` (457 lines, last changed 2026-07-18, `71a5bb909e01`)
- `hmi/src/handsFreeController.ts` (564 lines, last changed 2026-08-01, `30aa9f060d9e`)
- `hmi/src/ttsQueue.mjs` (142 lines)

### `packages/voice/src/machine.ts` — architecture borrowed, code written here

Our comment reads "Modeled on the cockpit-agent voice FSM, reduced to the P0
states" (`machine.ts:47`). That is accurate, and "modeled on" is the right verb:
no upstream code is present in this file.

What is shared is the shape of the solution: a pure state machine with no DOM and
no timers of its own, timers and effects injected as dependencies so the whole
loop is testable in Node, a table of named timers with a clear-all, and a single
transition funnel that reports each state change to an `onState` effect.

What is not shared is the machine. Upstream's states are `IDLE / ARMED /
LISTENING / THINKING / SPEAKING / FOLLOWUP`, driven by a wake word and voice
activity detection; ours are `idle / listening / transcribing / submitting /
speaking / error`, driven by a button press and a transcript the user can edit
before confirming. Only `listening` and `speaking` exist in both, and they do not
mean the same thing. Upstream's own header says push-to-talk and text input do
not enter its FSM (`voiceLoop.mjs:13`) — our machine is exactly the path
upstream excludes. None of upstream's substance is here: no wake word, no VAD, no
barge-in confirmation window, no echo fingerprinting, no self-trigger counting,
no exit-word or filler heuristics, no endpoint grace merging, no metrics. Where
the two files do the same kind of thing they do not do it the same way — our
named timers are a `Map` with `setNamedTimer(name, fn, ms)`, upstream's are an
object with `_setTimer(name, ms, fn)`; ours is a closure factory, upstream's a
class; ours suppresses same-state transitions, upstream's does not.

**Judgment: ordinary technical borrowing of an architecture.** Attribution is
credit given, not an obligation discharged.

### `packages/voice/src/speech.ts` — mostly ours, one idiom taken with its names

This file wraps the browser's `SpeechRecognition` and `speechSynthesis`. Upstream
has no counterpart for that work: it streams PCM to a server-side recognizer over
a WebSocket with a pre-roll ring buffer. The structural DOM types, the error-code
mapping, the teardown and detach logic, and the secure-context checks have no
upstream original and were written here.

One element is closer than "modeled on", and it should be stated plainly rather
than smoothed over. The recognition generation guard is the same technique
carrying the same identifiers:

```
upstream  handsFreeController.ts:504-505, and :521-524
    const gen = ++this.asrGen
    const fresh = () => gen === this.asrGen
    onPartial: (t) => { if (!fresh()) return; ... }

ours      speech.ts:184-185, and :204-224
    const gen = ++asrGen
    const fresh = () => gen === asrGen && !disposed
    engine.onresult = (event) => { if (!fresh()) return; ... }
```

`asrGen`, `gen`, `fresh`, and the leading `if (!fresh()) return` guard in each
engine callback line up one-to-one; the adaptation is a class field becoming a
closure variable, plus the `&& !disposed` conjunct. The `disposed` flag and the
latching `dispose()` likewise share upstream's name and purpose
(`handsFreeController.ts:72`, `:246`).

The playback-side guard (`speakGen`) is the same idea, but its upstream
counterpart is in `ttsQueue.mjs:103-137` (`this.generation`, snapshotted per
enqueue and compared as `generation !== this.generation`), not in the controller,
and it shares no identifiers with ours. The in-code comment at `speech.ts:126-129`
was corrected accordingly, so that the code and this file agree on where each
guard comes from.

**Judgment: no upstream file was copied; a few lines of one guard idiom, and
three identifier names, are recognizably taken.** Whether that amount crosses the
threshold of copyrightable expression is a question this file does not try to
settle — it is a legal judgment, not an engineering one, and getting it wrong in
either direction has a cost. What can be said without a lawyer is that
attribution costs nothing and is already present at the point of use, and that
the honest description of the amount is the one above rather than either "we
copied their controller" or "we only looked at the idea".

If the owner chooses to treat `packages/voice` as a Derivative Work under Apache
License 2.0, the practical consequences of §4 for this repository would be:

- **§4(a)** — ship a copy of the Apache 2.0 license with the distribution.
- **§4(b)** — state prominently that the files carry modifications. Both files
  already say so in their own headers; this section makes it explicit.
- **§4(c)** — retain the attribution notices found in the source. The three
  upstream files contain none to retain.
- **§4(d)** — propagate upstream's `NOTICE` contents. Upstream has no `NOTICE`
  file, so there is nothing to propagate. This file is deliberately not named
  `NOTICE`: that filename is Apache 2.0's term of art for the file whose contents
  downstream redistributors must carry, and naming it that would quietly assert
  an answer to the Derivative Work question above.

## 3. Projects evaluated and not used

Each of these appears in the project's own reference notes as a candidate. None
contributed code, data, schema, or field names to this repository. Licenses are
listed because the evaluation record is only useful if it is accurate, not
because anything is owed.

| Project | License (verified 2026-08-03) | Verified from | Why it is not in the repository |
|---|---|---|---|
| [vercel-labs/json-render](https://github.com/vercel-labs/json-render) | Apache-2.0 | https://github.com/vercel-labs/json-render/blob/main/LICENSE | The reference notes named it as the intended generative-UI renderer. It was never adopted: there is no occurrence of it anywhere in this repository, and `apps/demo/src/ui/UISpecRenderer.tsx:621` dispatches a closed component union through a hand-written `switch`. A ten-case switch over a Zod-validated union is what the UI Schema v1 whitelist actually calls for, and it keeps the browser dependency surface at react + react-dom + zod. |
| [COVESA Vehicle Signal Specification](https://github.com/COVESA/vehicle_signal_specification) | MPL-2.0 | https://github.com/COVESA/vehicle_signal_specification/blob/master/LICENSE | The reference notes planned a VSS-shaped mock. Not adopted: the vehicle context is a five-field local schema (`speedKph`, `batteryPercent`, `remainingRangeKm`, `gear`, `isNight` — `packages/schema/src/api.ts:5-11`), and no VSS path such as `Vehicle.Speed` appears anywhere. The demo consumes five fields; adopting a signal taxonomy for five fields would have bought naming compatibility with a vehicle bus this POC never touches. |
| [Eclipse KUKSA databroker](https://github.com/eclipse-kuksa/kuksa-databroker) | Apache-2.0 | https://github.com/eclipse-kuksa/kuksa-databroker/blob/main/LICENSE | Explicitly deferred in the project's own decisions: no real vehicle signal path in the POC. |
| [a2ui-project/a2ui](https://github.com/a2ui-project/a2ui) | Apache-2.0 | https://github.com/a2ui-project/a2ui/blob/main/LICENSE | Evaluated as a declarative agent-to-UI protocol. The project ships its own UI Schema v1 instead, whose whitelist is tied to the airport-pickup component catalog. |
| [AGenUI/AGenUI](https://github.com/AGenUI/AGenUI) | Apache-2.0 | https://github.com/AGenUI/AGenUI/blob/main/LICENSE | Evaluated as an A2UI renderer. Not adopted, for the same reason as A2UI itself. |
| [CopilotKit/CopilotKit](https://github.com/CopilotKit/CopilotKit) | MIT | https://github.com/CopilotKit/CopilotKit/blob/main/LICENSE | Evaluated as a full agent frontend. Not adopted: the demo's UI is driven by a server-composed UISpec, not by a chat-centric frontend framework. |
| [ag-ui-protocol/ag-ui](https://github.com/ag-ui-protocol/ag-ui) | MIT | https://github.com/ag-ui-protocol/ag-ui/blob/main/LICENSE | Noted as a possible later standardization of agent-to-frontend events. The transport here is one `task.updated` full-snapshot SSE event. |

Other projects named in the reference notes — Android Car Samples,
CarToolForge / CarToolPlayground, mercedes-benz/agent-testing-framework — were
background reading rather than selection candidates. Nothing from them is present
here, and their licenses were not verified for this file.

## Unresolved

**This repository has no license.** There is no `LICENSE` file, and every
`package.json` carries `"private": true` with no `license` field. That is a
deliberate gap in this file's scope, not an oversight to be filled in passing:
choosing a license is the owner's decision, and it is not reversible in practice
once other people have relied on it.

Two things follow that the owner may want to decide together:

1. **What license, if any, this project carries.** Under default copyright,
   third parties have no permission to use, copy, or modify this code, and the
   repository being publicly readable does not change that.
2. **Whether `packages/voice` is treated as a Derivative Work of cockpit-agent**
   (§2 above). If yes, Apache 2.0 §4(a) asks that a copy of the Apache license
   travel with the distribution, which interacts with the answer to (1).
