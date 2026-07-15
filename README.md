# CanvasFlow

CanvasFlow is a generative UI prototype for the Auto-Link company competition.

The repository is set up for a three-person, agent-assisted workflow:

- Normal implementation pull requests target `dev`; the owner promotes `dev` to `main` for a release.
- CI runs linting, type checking, tests, and production builds.
- `CODEOWNERS` requests review from the repository owner by default.
- PRs include an agent / Codex review checklist.
- Same-repository PRs can trigger automated Codex review when repository secrets are configured.

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

The upstream repository stays private. Teammates keep their normal `Write` access, push short-lived branches to the shared repository, and open PRs into `dev`. The owner reviews and merges those PRs, then promotes `dev` to `main`. GitHub Free cannot enforce branch protection on a private repository, so direct pushes to `dev` and `main` are prohibited by team convention and checked by CI where possible.