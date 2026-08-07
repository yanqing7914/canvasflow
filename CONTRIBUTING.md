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

The end-to-end suite needs three browsers once per machine:

```bash
npx playwright install chromium webkit firefox
```

CI runs all three, but not the same specs on each. The floating glass panel is
the one part of the demo whose correctness is an engine question rather than a
code question — `:has()` decides whether the panel exists, `display: contents`
decides whether folding hides anything, `backdrop-filter` decides whether the
result is legible, and every failure is visual rather than assertable from the
unit suite. So the panel's own behaviour lives in one spec tagged `@glass`, and
the `webkit-glass` and `firefox-glass` projects run it on every PR. That tag
earned its keep immediately: Gecko sized the panel 100px shorter than its
contents, and the card hides its overflow, so the fold button was clipped out of
the card and unclickable on Firefox alone.

The wider `@layout` sweep on the extra engines stays opt-in:

```bash
PLAYWRIGHT_CROSS_BROWSER=1 npm run test:e2e -- --grep @layout
```

Without the variable those two projects do not exist, so the default run is the
three CI has.

It is opt-in rather than required because two of its specs fail on the extra
engines today, and both are known:

- **Gecko, four specs, `expectNoScroll`.** The voice composer is on screen from
  the first frame in Firefox — `SpeechRecognition` is unimplemented, so the
  keyboard is the only input there — and its ~140px is not in the fixed frame's
  budget. `.ui-slot--main`'s stacked cards then ask for more than the slot has
  and Gecko reports the difference as `scrollHeight`, where Blink compresses the
  same rows to fit. This is the fixed frame genuinely not holding on a
  keyboard-only browser, not a measurement artefact.
- **WebKit and Gecko, the keyboard-accessibility sweep.** Safari excludes links
  from the tab order unless "Press Tab to highlight each item" is on, so the
  brand lockup is skipped; Firefox has no voice entry to tab past. Both are
  browser preferences rather than app defects, so the fix belongs in the spec's
  expectations rather than in the app.

Neither is caused by the glass panel, and neither blocks it: the `@glass` spec
asserts the panel's behaviour and deliberately not the frame, so it is clear of
the Gecko composer issue above and can be required on all three engines without
gating every PR on an unrelated known failure. One consequence of that composer
issue is visible in the panel on Firefox — the shorter map leaves the panel
overhanging its lower edge — and it resolves when the composer does.

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
