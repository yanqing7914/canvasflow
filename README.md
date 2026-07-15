# CanvasFlow

CanvasFlow is a generative UI prototype for the Auto-Link company competition.

The repository is set up for a three-person, agent-assisted workflow:

- Normal implementation pull requests target `dev`; the owner promotes `dev` to `main` for a release.
- CI runs linting, type checking, tests, and production builds.
- `CODEOWNERS` requests review from the repository owner by default.
- PRs include an agent / Codex review checklist.
- Same-repository PRs can trigger automated Codex review when repository secrets are configured. Fork PRs use the local Codex review handoff because GitHub does not safely expose secrets to untrusted fork code.

## Getting Started

```bash
npm install
npm run dev
```

## Quality Gate

Run these commands before requesting review:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Collaboration

The upstream repository stays private. Teammates use private forks and open PRs into `dev`; the owner is the only person who merges upstream changes. This permission-based workflow replaces unavailable branch protection on GitHub Free private repositories.
