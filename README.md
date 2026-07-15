# CanvasFlow

CanvasFlow is a generative UI prototype for the Auto-Link company competition.

The repository is set up for a three-person, agent-assisted workflow:

- All implementation work happens through pull requests.
- CI runs linting, type checking, tests, and production builds.
- `CODEOWNERS` requests review from the repository owner by default.
- PRs include an agent / Codex review checklist.
- Pull requests trigger automated Codex review when repository secrets are configured.

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

Teammates can push feature branches and open PRs. The `main` branch should stay protected by CI and owner review.
