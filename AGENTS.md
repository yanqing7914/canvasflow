# CanvasFlow Agent Guide

This repository is designed for agent-assisted development. Treat `main` as protected and production-ready.

## Required Checks

Before opening or updating a PR, run:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Working Rules

- Create a feature branch for every change.
- Keep generated code readable and easy for a teammate to inspect.
- Prefer small components and clear state transitions.
- Add tests for logic, rendering states, and user interactions.
- Never commit secrets or generated local credentials.

## Review Rules

- The repository owner is the default code owner.
- PRs should not merge until CI is green and owner review is complete.
- Use Codex or another agent for a second-pass review when the change touches shared UI flows, state models, or deployment configuration.

