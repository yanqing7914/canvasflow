# Five-Minute Competition Demo

This script demonstrates the shipped Fixture-mode path. It uses the Demo UI,
which sends text, events, actions, and confirmations only through the Agent
HTTP API. Do not call reducers or tool providers from browser developer tools.

## Before The Recording

1. Run `npm run build` and start `AGENT_DATABASE_PATH=:memory: npm run preview`.
2. Open `http://127.0.0.1:4173` at 1920x720 and confirm `/health` is healthy.
3. Keep the Event console and Effect receipts visible. Use Fixture mode unless
   a separately reviewed live Provider deployment is available.

## 0:00 - 0:45: Goal To Structured Task

1. Enter `接妈妈和豆豆，航班 MU 5102` and submit it.
2. Point out that passenger and flight slots become a normalized, reviewable
   task state (`MU5102`), rather than opaque model output.
3. If the UI asks for a missing slot, provide it in the same text input and
   show the task moving to the prepared navigation state.

## 0:45 - 1:45: Policy-Gated Departure

1. Show the route, charging recommendation, and vehicle context in the
   generated interface.
2. Optional query beat: say or type `到的时候天气怎么样`. A transient weather
   card answers on the same brief — it borrows the schedule strip's slot, so
   the frame does not grow — and the spoken reply carries the pickup advisory.
   State the boundary: a query turn changes no task fact, and the very next
   trip event gives the surface back (the strip returns). Fixed forms only:
   `看下天气` / `天气怎么样` / `到的时候天气怎么样`.
   The schedule query rides the same contract: `看看我的日程` /
   `今天有什么安排` / `我的待办` answers with a schedule card listing the
   day's remaining events — same borrowed slot, same transience. Run one query
   or the other in the live demo; both demonstrates the pattern, not more value.
3. Select `开始导航`.
4. Point to the `navigation.start:succeeded` receipt. Explain that the Agent
   publishes the driving state only after the policy gate and Provider result
   succeed.
5. Use `推进下一事件` to show flight and charging updates.
6. **The proactive rain beat** (the third memorable moment): the in-air flight
   update firms up the arrival window, the Agent checks the forecast, finds
   rain, and the advisory card takes the rail on its own — a condition raised
   it, not a timer, and nobody asked a question. Say the boundary out loud:
   the trip never re-prompts (dismissed or answered, the advisory is retired).
7. Press `提醒乘客带伞` (or speak it). The exact provider-prepared message
   appears for review — nothing has been sent. Press `确认发送` and point to
   the `message.send:succeeded` receipt: a real side effect behind a real
   confirmation, and the drive takes the screen back. `暂不处理` is the other
   branch for the backup recording.

## 1:45 - 2:35: Arrival And Authorized Message

1. Advance to the landed-flight update and show the landing notification.
2. Advance once more and show the `message.send:succeeded` receipt.
3. Explain that message authorization, task state, and Provider envelope data
   are checked before a send is represented as successful.

## 2:35 - 3:35: Return Trip And Undo

1. Advance through airport arrival, parking, and passenger onboarding.
2. Show return route, `vehicle.apply-cabin-profile:succeeded`, and
   `media.play:succeeded` receipts.
3. Use `恢复座舱设置` (or the rendered cabin undo control) when available, then
   show the matching revert receipt. This demonstrates an executable undo, not
   only a UI state toggle.

## 3:35 - 4:20: Memory Confirmation

1. Advance to home arrival and show the pending long-term memory proposal.
2. Select `保存本次偏好` and show `memory.confirm-update:succeeded`.
3. State that `暂不保存` is the distinct rejection route; use it in the backup
   recording to demonstrate that it does not persist the proposal.

## 4:20 - 5:00: Resilience And Boundaries

1. Start a fresh task with fixture flight `MU0000` to demonstrate the
   deterministic fallback UI.
2. Explain that previous task facts remain visible while the Agent reports the
   Provider failure; a false success is never shown.
3. Close with the boundaries: Fixture data is fictional; live Providers require
   injected credentials, durable external idempotency, and operational review.

## Optional: Model Canonicalization Segment

This segment proves that model planning is a bounded, verifiable assist on top
of the rules — not the other way around. Run it only after rehearsing on the
venue network; the whole demo works rules-only if the model is unavailable.

### Setup

Start the preview with the model environment configured. Supply the key from
the deployment environment; never write it into a file or show it on screen:

```bash
AGENT_MODEL_MODE=openai-compatible \
AGENT_MODEL_ENDPOINT=https://cc.auto-link.com.cn/pro/v1/chat/completions \
AGENT_MODEL_ALLOWED_HOSTS=cc.auto-link.com.cn \
AGENT_MODEL_API_KEY=... \
AGENT_MODEL_ID=anthropic.claude-haiku-4-5 \
AGENT_DATABASE_PATH=:memory: npm run preview
```

### Verified Lines

The rules planner resolves most phrasings by itself; only input it reports as
unknown ever reaches the model. These lines were verified end to end against
the endpoint above (about 3 seconds per turn):

| Line | Path |
| --- | --- |
| `我现在要去机场接妈妈和豆豆` | Rules. The drawer's 规划来源 row shows `规则`. |
| `麻烦你去机场把妈妈和豆豆接回来` | Model. The brief shows the 模型参与 disclosure and 规划来源 names the model ID. |
| `能不能去机场把妈妈接回来` | Model, single passenger. |

### Script

1. Create a task with the rules line and point at 规划来源 `规则`: the
   deterministic path handles known phrasing with no model call at all.
2. Reset, then create a task with a model line. Point at the on-brief
   disclosure and the model ID in the drawer.
3. State the boundary: the model only canonicalizes unknown slot input. Its
   output is re-planned by the same rules, checked against verbatim evidence
   from the original words, and discarded on any failure, timeout, or low
   confidence — the turn then falls back to deterministic behavior, so the
   demo cannot be stranded by the model.

## Recording Notes

- Capture one uninterrupted happy-path recording and a short fallback clip.
- Do not show terminal windows containing credentials, environment files, or
  local database paths.
- Record the exact release candidate commit and browser viewport with each
  artifact so it can be reproduced during final review.
