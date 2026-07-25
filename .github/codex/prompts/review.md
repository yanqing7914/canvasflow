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

## Required Final Format

Your final response is posted to the pull request and parsed by automation. Do not end the review until you have written a concise human-readable conclusion followed by exactly one of the verdict lines below as the final line of your response.

```text
CODEX-REVIEW-VERDICT: PASS
```

Use `PASS` only when there are no unresolved P0 or P1 findings. Otherwise end with:

```text
CODEX-REVIEW-VERDICT: BLOCK
```

Never quote either verdict line anywhere else in the response. Never omit the final verdict line. A malformed or missing verdict fails the review workflow and prevents automatic merge.
