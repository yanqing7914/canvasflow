# Contributing to CanvasFlow

## Team Workflow

1. Create a branch from `main`.
2. Let your coding agent implement a small, reviewable change.
3. Run the local quality checks.
4. Open a pull request into `main`.
5. Wait for CI and owner review before merging.

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

## Local Commands

```bash
npm install
npm run dev
npm run lint
npm run typecheck
npm test
npm run build
```

