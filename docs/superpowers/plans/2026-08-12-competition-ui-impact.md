# Competition UI Impact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the airport-pickup demo read as one memorable, continuously evolving in-car journey without changing its data or action contracts.

**Architecture:** Add a shell-owned semantic journey rail driven only by the existing task phase, then update theme-aware presentation CSS and finish the already-started minimum navigation HUD. Business facts remain inside validated `UISpec` components; the shell only presents phase continuity.

**Tech Stack:** React 19, TypeScript, CSS, Vitest, Testing Library, Playwright

---

### Task 1: Journey Stage Mapping

**Files:**
- Modify: `apps/demo/src/App.test.tsx`
- Modify: `apps/demo/src/App.tsx`

- [x] Add failing tests asserting that the rail is absent without a task, maps preparing/driving/return/completed phases to the correct current step, marks earlier steps completed, and marks cancellation without a false current step.
- [x] Run `npm test -- apps/demo/src/App.test.tsx` and confirm the new rail assertions fail because the rail does not exist.
- [x] Add the four-stage display model and a small `JourneyPhaseRail` component in `App.tsx`; render it after the header only when a task exists.
- [x] Run `npm test -- apps/demo/src/App.test.tsx` and confirm the focused application tests pass.

### Task 2: Competition Shell Presentation

**Files:**
- Modify: `apps/demo/src/style.css`
- Test: `tests/e2e/app.spec.ts`

- [x] Add a failing layout assertion that the journey rail remains inside the Trip Brief and the desktop frame has no horizontal or vertical overflow.
- [x] Run the focused Playwright layout spec and confirm it fails before the rail styles exist.
- [x] Add theme-aware cabin atmosphere, Trip Brief silhouette, phase accent, rail layout, contextual heading label, responsive rules, and reduced-motion handling.
- [x] Run the focused Playwright layout spec and confirm it passes.

### Task 3: Minimum Navigation HUD

**Files:**
- Modify: `apps/demo/src/ui/navigation/NavigationWorkspace.test.tsx`
- Modify: `apps/demo/src/ui/navigation/NavigationHUD.tsx`
- Modify: `apps/demo/src/style.css`

- [x] Replace the incomplete arrival-alert test with a failing render that starts from a genuinely collapsed HUD and advances the simulator to arrival.
- [x] Run `npm test -- apps/demo/src/ui/navigation/NavigationWorkspace.test.tsx` and confirm the alert-precedence assertion fails for the expected reason.
- [x] Finish the collapsed HUD markup and shared visual tokens so destination, metrics, maneuver, alert, and toggle keep a stable hierarchy across desktop and mobile.
- [x] Run the navigation workspace tests and confirm they pass.

### Task 4: Visual Verification And Regression Checks

**Files:**
- Modify only if a verified regression requires a focused fix.

- [ ] Run `npm run lint`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Run `npm run test:e2e`.
- [ ] Run `PLAYWRIGHT_CROSS_BROWSER=1 npm run test:e2e -- --grep @layout` when the installed browsers are available; report known unrelated failures exactly if they remain.
- [ ] Inspect desktop day, desktop night, fullscreen navigation, collapsed HUD, and mobile screenshots in the browser.

### Task 5: Review And Pull Request

**Files:**
- Modify: PR metadata only.

- [ ] Review the final diff for unrelated formatting, secrets, schema drift, and loss of keyboard accessibility.
- [ ] Commit the design and implementation in reviewable commits without including unrelated untracked files.
- [ ] Push `feat/navigation-minimum-hud` to `origin`.
- [ ] Open a PR into `dev` describing before/after behavior, tests, visual changes, risk, rollback, and author review.
- [ ] Attach or reference the captured UI screenshots in the PR when supported by the repository workflow.
