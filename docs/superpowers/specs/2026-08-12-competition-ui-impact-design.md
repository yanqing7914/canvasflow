# Competition UI Impact Design

## Goal

Strengthen the competition demo's first-impression impact while preserving the existing `UISpec`, action, task-state, and safety contracts. The interface should read as one continuous in-car journey rather than a collection of information panels.

## Direction

Use a journey-first presentation. The current component conclusion remains the primary content, while the shell makes the four-stage airport-pickup story continuously visible:

1. Prepare
2. Drive to the airport
3. Bring the passengers home
4. Complete the trip

The shell may map the existing task phase to these display stages, but it must not reconstruct flight, route, battery, passenger, or preference facts from task state. Those facts continue to come only from the validated `UISpec` components.

## Visual Structure

- Add a compact, semantic four-stage journey rail between the utility header and task content.
- Keep the existing phase identity beside the pilotflow wordmark; the rail explains continuity while the phase identity explains the current precise state.
- Give the cabin background a restrained environmental field using theme-aware radial light, a subtle technical grid, and a phase accent. Content surfaces remain opaque and high contrast.
- Add a slim phase-colored edge and stronger silhouette to the Trip Brief so it reads as the single persistent object that evolves.
- Keep the current conclusion-first component hierarchy. The shell title becomes a clearly labelled journey context when a component already owns the conclusion.
- Preserve the existing day/night theme and reduced-motion behavior.

## Journey Rail Behavior

The rail is an ordered list labelled `接机行程阶段`. Each item exposes one of `completed`, `current`, or `upcoming` as a data attribute for styling and tests.

Phase mapping:

- Stage 1, `准备`: collecting airport or information, choosing a flight, confirming outbound, and preparing.
- Stage 2, `接机`: outbound driving, driving to the airport, approaching the airport, and waiting for passengers.
- Stage 3, `返程`: passengers onboard, confirming return, return driving, and returning home.
- Stage 4, `到家`: completed.
- Cancelled tasks show the rail in a cancelled state with no falsely active stage.

Before a task exists, the rail is not rendered. On narrow screens, labels stay readable in a compact four-column layout; no horizontal scrolling is introduced.

## Navigation HUD

- Treat the existing minimum-HUD work as part of this change.
- The collapsed HUD keeps destination, speed, battery, and the current road/maneuver.
- An arrival or safety alert replaces the maneuver rather than competing with it.
- Expanded and collapsed HUDs share surface, type, spacing, and control treatments.
- Mobile uses a two-column arrangement with destination and maneuver/alert spanning the width.

## Motion

- A phase change may animate the brief once with a short settle and rail progress reveal.
- No continuous pulse, glow, or moving decorative element is allowed.
- `prefers-reduced-motion: reduce` disables the new transitions.

## Accessibility And Safety

- The journey rail is semantic but non-interactive.
- Current status is announced through text and `aria-current="step"`, not color alone.
- Existing buttons, focus rings, landmarks, action dispatch, drawer focus management, and voice fallback remain unchanged.
- Driving density and component visibility remain controlled by the existing spec and vehicle context.

## Responsive Strategy

- Desktop keeps the fixed competition frame and reserves a compact row for the journey rail.
- Tablet reduces labels and spacing before reducing the primary conclusion.
- Mobile allows natural vertical scrolling, keeps four stages in one row, and shortens supporting labels without hiding the current stage.

## Test Strategy

- Unit-test the phase-to-stage mapping through the rendered rail, including initial, middle, completed, cancelled, and no-task states.
- Repair and extend the minimum-HUD test so it actually renders the collapsed HUD and verifies alert precedence.
- Retain existing renderer, application, keyboard, voice, layout, and E2E coverage.
- Visually verify the initial screen, flight selection, preparing screen, fullscreen navigation, night theme, and a mobile viewport.

## Scope Boundaries

- No schema changes.
- No new task facts or provider data.
- No new controls or side effects.
- No redesign of the demo drawer or cockpit window manager.
- No unrelated component refactor.
