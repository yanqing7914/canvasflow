# CanvasFlow Agent Guide

This repository is designed for agent-assisted development. It is a public repository with three collaborators who have normal `Write` access. `dev` and `main` are protected branches: direct pushes are rejected, force pushes and branch deletion are blocked, and every change must arrive through a pull request that passes the required checks. Repository administrators can bypass protection, so the owner still avoids pushing directly.

## Repo Shape

- `main` is the release branch and contains the version submitted to the competition.
- `dev` is the integration branch. Teammate pull requests target `dev`; the owner promotes a tested `dev` to `main`.
- All work happens on short-lived `feat/*`, `fix/*`, `test/*`, or `chore/*` branches.
- Every change lands through a pull request.
- Keep pull requests small enough to review in one sitting.
- Teammates may push short-lived feature branches to the upstream repository. Direct pushes to `dev` or `main` are rejected by branch protection.

## Repository Settings

The repository is public, but it is not open for outside contributions during the competition:

- Issues are disabled.
- Interaction is limited to collaborators. The limit expires on 2027-01-27 and has to be renewed if it is still needed.
- Workflows on pull requests from forks require manual approval from a maintainer.
- `dev` and `main` require the `quality`, `e2e`, and `branch-and-files` checks to pass. They do not require an approving review, because the auto-merge automation acts with `GITHUB_TOKEN` and cannot approve a pull request.

## Required Checks

Before opening or updating a PR, run:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

The end-to-end suite needs a browser once per machine: `npx playwright install chromium`.

## Development Flow

1. Sync the latest `dev` branch from `origin`. Start from `main` only for an owner-managed release or hotfix.
2. Create a short-lived branch from `origin/dev` for the current change.
3. Implement the smallest coherent slice of work.
4. Add or update tests when behavior changes.
5. Run the required checks locally.
6. Push the branch to the shared upstream repository and open a PR into `dev`.
7. Wait for the automation: once CI is green and the latest completed Codex review ends with `CODEX-REVIEW-VERDICT: PASS`, the review workflow squash-merges the PR into `dev` automatically. Do not merge ordinary PRs manually; if auto-merge fails, fix the reported cause and push again, or escalate to the owner.
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

The PR author must describe before/after behavior, tests run, visual changes, known risks, and rollback approach. Generated code must be reviewed by the author before handoff. A PR merges automatically once CI is green and the latest completed Codex review reports a PASS verdict; a green CI job alone is not sufficient, and owner review is no longer a merge gate for ordinary PRs into `dev`. Branch protection rejects a direct push to `dev` or `main`, so a commit can only land outside this flow if an administrator bypasses protection; if that happens, stop and notify the owner so the commit can be reviewed or reverted.

For a UI change, include a screenshot or short recording. For behavior changes, add a focused test or explain why a test is not practical. Never claim that a check ran if it did not run.

## Review guidelines

- The repository owner is the default code owner.
- PRs should not merge until CI is green and the latest completed Codex review has no unresolved P0 or P1 findings. A failed, cancelled, or still-running Codex review is not a passing review.
- Ordinary same-repo PRs into `dev` are squash-merged automatically by the Codex review workflow on a PASS verdict. The `dev` -> `main` release PR is never auto-merged; only the owner merges it.
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
