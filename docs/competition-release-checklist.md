# Competition Release Checklist

This checklist gates the owner-managed `dev -> main` release PR. Normal
development PRs must target `dev` and must not merge the release branch.

## Scope And Evidence

- [ ] The release PR is `dev -> main`; its head and base commits are recorded.
- [ ] Every included feature PR has green `quality`, `e2e`, and
  `branch-and-files` checks and a latest Codex `PASS` verdict.
- [ ] The release diff contains no `.env`, credential, private data, or local
  database files.
- [ ] The release notes list user-visible behavior, known limitations, and a
  revert commit or rollback owner.

## Local Verification

Run these against the exact release candidate commit:

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

- [ ] Record the actual Vitest and Playwright test counts in the release PR.
- [ ] The production-style preview starts with
  `AGENT_DATABASE_PATH=:memory: npm run preview`.
- [ ] `GET /health` returns successfully and the preview serves both the demo
  and the `/v1` Agent API.

## Demo Acceptance

Use [the five-minute demo script](competition-demo-script.md) without manual
state editing or direct reducer/tool calls.

- [ ] The primary airport-pickup flow completes through the Agent API.
- [ ] Navigation, landing notification, return route, cabin, media, and memory
  confirmation show truthful effect receipts.
- [ ] One reversible cabin action is demonstrated.
- [ ] The fixture failure path shows deterministic fallback UI without
  overwriting the prior task facts.
- [ ] Browser acceptance is checked at 1920x720 and a mobile viewport; keyboard
  traversal reaches the primary input and action controls.

## Media Deliverables

Keep generated captures outside source control unless the owner explicitly
requests a versioned media asset. Store the final URLs or handoff locations in
the release PR description.

- [ ] Capture a 1920x720 screenshot of the prepared navigation task.
- [ ] Capture a 1920x720 screenshot of the return-trip result with cabin/media
  receipts and the undo action visible.
- [ ] Record the complete happy-path demo following the script.
- [ ] Record or verify the fallback demo path.
- [ ] Export a backup video that can be played without the local Agent runtime.
- [ ] Prepare slides that use the current architecture diagram and the two
  screenshots, without embedding credentials or private data.

## Final Owner Decision

- [ ] The owner reviews the release PR and its artifacts.
- [ ] The owner merges `dev -> main`; do not use ordinary PR auto-merge for the
  release.
- [ ] After merge, re-run `/health` and the primary demo flow against the
  released runtime or documented deployment target.
