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
2. Select `开始导航`.
3. Point to the `navigation.start:succeeded` receipt. Explain that the Agent
   publishes the driving state only after the policy gate and Provider result
   succeed.
4. Use `推进下一事件` to show flight and charging updates.

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

## Recording Notes

- Capture one uninterrupted happy-path recording and a short fallback clip.
- Do not show terminal windows containing credentials, environment files, or
  local database paths.
- Record the exact release candidate commit and browser viewport with each
  artifact so it can be reproduced during final review.
