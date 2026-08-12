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
  const primaryWindow = windows.find((window) => primaryWindowKinds.has(window.kind))
  const auxiliaryWindows = windows.filter((window) => window !== primaryWindow)

  let mode: CockpitViewMode = 'primary'
  if (isTerminalPhase(spec.phase)) mode = 'terminal'
  else if (isNavigationWorkspacePhase(spec.phase)) mode = 'navigation'

  return { mode, phase: spec.phase, primaryWindow, auxiliaryWindows }
}

export function isPrimaryCockpitWindow(kind: CockpitWindowSpec['kind']): boolean {
  return primaryWindowKinds.has(kind)
}
