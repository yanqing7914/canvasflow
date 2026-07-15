# CanvasFlow Agent Guide

This repository is designed for agent-assisted development. Treat `main` as protected and production-ready.

## Repo Shape

- `main` is the only long-lived branch.
- All work happens on short-lived `feat/*`, `fix/*`, or `chore/*` branches.
- Every change lands through a pull request.
- Keep pull requests small enough to review in one sitting.

## Required Checks

Before opening or updating a PR, run:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Development Flow

1. Start from the latest `main`.
2. Create a new branch for the current change.
3. Implement the smallest coherent slice of work.
4. Add or update tests when behavior changes.
5. Run the required checks locally.
6. Push the branch and open a PR.
7. Wait for CI, Codex review, and owner review before merge.

## Working Rules

- Never commit secrets, API keys, or generated local credentials.
- Prefer explicit types, small components, and clear state transitions.
- Keep generated code readable enough that a teammate can review it quickly.
- Do not reformat unrelated files or widen a change beyond the stated PR scope.
- Preserve the existing visual language unless the PR is explicitly a redesign.
- If a change touches shared UI flows, state models, or deployment config, call out the risk in the PR body.

## Review guidelines

- The repository owner is the default code owner.
- PRs should not merge until CI is green, Codex review has run, and owner review is complete.
- Use Codex or another agent for a second-pass review when the change touches shared UI flows, state models, deployment config, or auth/security code.
- When reviewing, focus first on correctness, then regression risk, then clarity.
- Treat visual regressions, broken loading states, and lost keyboard accessibility as review blockers.
- Treat missing tests for changed behavior as a P1 issue unless the PR explains why tests are not practical.
- Treat committed secrets, private data, or accidental environment files as a P0 issue.

## Agent Handoff

- If you are a coding agent, leave the branch in a state that a human can understand without replaying the whole session.
- Summarize any compromises, follow-up ideas, and test gaps in the PR description.
- If you change public behavior, note the before/after behavior and the test coverage you added.
- If you are asked to review, do not silently edit unrelated files; report findings first, then fix only what was requested.
