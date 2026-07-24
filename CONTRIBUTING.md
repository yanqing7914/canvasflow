# Contributing to CanvasFlow

## Team Workflow

1. Sync the latest `dev` branch from the shared upstream repository.
2. Let your coding agent implement a small, reviewable change.
3. Run the local quality checks.
4. Push the short-lived branch to the shared upstream repository and open a pull request into `dev`.
5. Wait for green CI and a completed Codex review with no unresolved P0 or P1 findings before merging. The PR author does not self-merge their own change; another collaborator may merge an eligible PR.
6. The owner opens a separate `dev` -> `main` pull request for a competition release.

GitHub Free does not provide protected branches for private repositories. The team therefore treats `dev` and `main` as protected by convention: do not push directly to them, require CI and review on every PR, and let the owner handle the release merge. This is a process gate, not a server-enforced permission gate.

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
```

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
