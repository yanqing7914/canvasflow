# CanvasFlow Agent Guide

This repository is designed for agent-assisted development. It is a private GitHub Free repository, so access control is part of the merge gate: teammates work from private forks, while the owner is the only person who writes to or merges the upstream repository.

## Repo Shape

- `main` is the release branch and contains the version submitted to the competition.
- `dev` is the integration branch. Teammate pull requests target `dev`; the owner promotes a tested `dev` to `main`.
- All work happens on short-lived `feat/*`, `fix/*`, `test/*`, or `chore/*` branches.
- Every change lands through a pull request.
- Keep pull requests small enough to review in one sitting.
- If you cannot write to the upstream repository, work in your private fork and open a PR back to `yanqing7914/canvasflow`.

## Required Checks

Before opening or updating a PR, run:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Development Flow

1. Start from the latest `dev` for normal work. Start from `main` only for an owner-managed release or hotfix.
2. Create a new branch for the current change.
3. Implement the smallest coherent slice of work.
4. Add or update tests when behavior changes.
5. Run the required checks locally.
6. Push the branch to your fork and open a PR into `dev`.
7. Wait for CI and complete the local Codex review handoff before asking the owner to merge.
8. Only the owner opens and merges the `dev` -> `main` release PR.

## Working Rules

- Never commit secrets, API keys, or generated local credentials.
- Never add `.env`, `.env.*`, private keys, tokens, or copied production data. If a secret is exposed, stop and tell the owner; do not paste it into an issue or PR.
- Prefer explicit types, small components, and clear state transitions.
- Keep generated code readable enough that a teammate can review it quickly.
- Do not reformat unrelated files or widen a change beyond the stated PR scope.
- Preserve the existing visual language unless the PR is explicitly a redesign.
- If a change touches shared UI flows, state models, or deployment config, call out the risk in the PR body.

## Agent task contract

Before editing, read this file, `CONTRIBUTING.md`, the relevant source and tests, and the current PR description. Confirm the requested behavior and allowed files. Do not widen the task because a nearby cleanup looks attractive.

Stop and report instead of guessing when the request conflicts with product direction, a check fails for an unrelated reason, the change needs credentials or deployment access, the diff touches secrets or CI permissions, or another contributor's uncommitted work would be overwritten.

## Review and handoff contract

The PR author must describe before/after behavior, tests run, visual changes, known risks, and rollback approach. Generated code must be reviewed by the author before handoff. The owner performs the final merge decision after checking CI, the diff, and Codex feedback. A green CI job is necessary but is not a substitute for human review.

For a UI change, include a screenshot or short recording. For behavior changes, add a focused test or explain why a test is not practical. Never claim that a check ran if it did not run.

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
