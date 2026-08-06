# Contributing to CanvasFlow

## Team Workflow

1. Sync the latest `dev` branch from the shared upstream repository.
2. Let your coding agent implement a small, reviewable change.
3. Run the local quality checks.
4. Push the short-lived branch to the shared upstream repository and open a pull request into `dev`.
5. Wait for the automation: once CI is green and the latest completed Codex review ends with `CODEX-REVIEW-VERDICT: PASS`, the review workflow squash-merges the PR into `dev` automatically. Nobody merges ordinary PRs manually; if auto-merge fails, fix the reported cause and push again.
6. The owner opens a separate `dev` -> `main` pull request for a competition release.

`dev` and `main` are protected branches. Direct pushes are rejected, force pushes and branch deletion are blocked, and a pull request cannot merge until the `quality`, `e2e`, and `branch-and-files` checks pass. Protection does not require an approving review, because the auto-merge automation acts with `GITHUB_TOKEN` and cannot approve a pull request; the Codex verdict is what gates the merge. Repository administrators can bypass protection, so the owner still routes work through pull requests and handles the release merge.

The repository is public but closed to outside contributions during the competition: Issues are disabled, interaction is limited to collaborators until 2027-01-27, and workflows on pull requests from forks need maintainer approval.

## Branch Naming

Use short branch names:

- `feat/prompt-canvas`
- `fix/node-layout`
- `test/flow-generation`
- `chore/ci`

## Pull Request Standard

Every PR should include:

- A short summary of the change.
- Screenshots or recordings for visual UI changes.
- The commands used to test the change.
- Notes about what the agent generated and what the author reviewed before handoff.
- The target branch (`dev` for normal work, `main` only for an owner-managed release).
- A rollback plan or a statement that rollback is not needed.

## Local Commands

```bash
npm install
npm run dev
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

The end-to-end suite needs a browser once per machine:

```bash
npx playwright install chromium
```

CI runs Chromium only. The layout specs can also be run against WebKit and
Gecko, which is where the floating glass panel is actually worth checking —
`:has()`, `backdrop-filter`, and `display: contents` each behave a little
differently per engine, and the failures are visual rather than assertable from
the unit suite. Install the two extra browsers and set the gate:

```bash
npx playwright install webkit firefox
PLAYWRIGHT_CROSS_BROWSER=1 npm run test:e2e -- --grep @layout
```

Without the variable the two projects do not exist, so the default run stays on
the browser CI has.

## Shared repository setup

```bash
git remote -v
git fetch origin
git switch -c feat/your-task origin/dev
```

Push the feature branch to `origin` and open the PR against `origin/dev`.

After another PR is merged, update your branch before continuing:

```bash
git fetch origin
git rebase origin/dev
```
