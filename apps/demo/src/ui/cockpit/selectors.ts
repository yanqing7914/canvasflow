import type { UISpec } from '@canvasflow/schema'
import { navigationPhase, workspaceWindows, type CockpitWindowSpec } from '../navigation/contracts'

/** The coarse surface mode used by the persistent cockpit shell. */
export type CockpitViewMode = 'idle' | 'primary' | 'navigation' | 'terminal'

export type CockpitView = {
  mode: CockpitViewMode
  phase?: UISpec['phase']
  primaryWindow?: CockpitWindowSpec
  auxiliaryWindows: CockpitWindowSpec[]
}

const primaryWindowKinds = new Set<CockpitWindowSpec['kind']>([
  'flight-list',
  'outbound-confirmation',
  'passenger-onboard',
  'return-confirmation',
])

const phasePrimaryWindowKind: Partial<Record<UISpec['phase'], CockpitWindowSpec['kind']>> = {
  'choosing-flight': 'flight-list',
  'confirming-outbound': 'outbound-confirmation',
  'passengers-onboard': 'passenger-onboard',
  'confirming-return': 'return-confirmation',
}

function isTerminalPhase(phase: UISpec['phase']): boolean {
  return phase === 'completed' || phase === 'cancelled'
}

function isNavigationWorkspacePhase(phase: UISpec['phase']): boolean {
  return navigationPhase(phase) || phase === 'waiting-for-passengers'
}

/**
 * Derives cockpit presentation concerns from the legal UISpec. The task and
 * Agent remain the source of truth; this selector only decides where the
 * existing spec belongs inside the persistent shell.
 */
export function deriveCockpitView(spec?: UISpec | null): CockpitView {
  if (!spec) return { mode: 'idle', auxiliaryWindows: [] }

  const windows = workspaceWindows(spec)
  const expectedPrimaryKind = phasePrimaryWindowKind[spec.phase]
  const primaryWindow = expectedPrimaryKind
    ? [...windows].reverse().find((window) => window.kind === expectedPrimaryKind)
    // Older Composer specs do not declare `windows` yet. Treat their first
    // authored content window as the primary task surface so an airport
    // question or legacy replay never disappears into the auxiliary layer.
    : [...windows].reverse().find((window) => primaryWindowKinds.has(window.kind))
      ?? windows.find((window) => window.kind === 'processing' || window.kind === 'error')
  // Historical main-flow windows can remain declared for audit/replay, but the
  // cockpit presents exactly one current primary step. They are not auxiliary
  // tools and must not reappear as draggable weather-style windows.
  const auxiliaryWindows = windows.filter((window) => window.id !== primaryWindow?.id && !primaryWindowKinds.has(window.kind))

  let mode: CockpitViewMode = 'primary'
  if (isTerminalPhase(spec.phase)) mode = 'terminal'
  else if (isNavigationWorkspacePhase(spec.phase)) mode = 'navigation'

  return { mode, phase: spec.phase, primaryWindow, auxiliaryWindows }
}

export function isPrimaryCockpitWindow(kind: CockpitWindowSpec['kind']): boolean {
  return primaryWindowKinds.has(kind)
}
