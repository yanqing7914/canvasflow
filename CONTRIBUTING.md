# Contributing to CanvasFlow

## Team Workflow

1. Sync the latest `dev` branch from the upstream repository.
2. Let your coding agent implement a small, reviewable change.
3. Run the local quality checks.
4. Push the short-lived branch to your private fork and open a pull request into upstream `dev`.
5. Wait for CI and owner review before merging. The owner is the only upstream merger.
6. The owner opens a separate `dev` -> `main` pull request for a competition release.

GitHub Free does not provide protected branches for private repositories. To preserve a hard permission boundary, teammates should have `Read` access to the upstream repository and work from private forks. Do not grant `Write` access unless the owner explicitly accepts direct-push risk.

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
- Notes about what the agent generated and what a human reviewed.
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

## Fork setup

```bash
git remote add upstream https://github.com/yanqing7914/canvasflow.git
git fetch upstream
git switch -c feat/your-task upstream/dev
```

Push to your fork (`origin`) and open the PR against `upstream/dev`.
