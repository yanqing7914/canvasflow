# CanvasFlow PR Review Prompt

Review this pull request as a strict but practical senior engineer.

Focus on:

- correctness bugs
- regressions in user-facing behavior
- missing or weak tests
- accessibility or keyboard interaction problems
- state management issues
- CI or deployment risks

Keep the review high-signal:

- Prefer P0/P1 severity issues.
- Avoid commenting on style unless it hides a real bug or maintainability risk.
- Call out assumptions explicitly when the change depends on them.
- If you see no blocking issues, say so clearly and mention residual risk or missing tests.

Repository context:

- `main` is the stable branch.
- All changes should land via pull request.
- This repo uses `AGENTS.md` as durable guidance.

