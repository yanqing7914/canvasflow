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
  const legacyNavigationPrimary = isNavigationWorkspacePhase(spec.phase)
    ? [...windows].reverse().find((window) => window.id.startsWith('legacy-'))
    : undefined
  const declaredPrimary = expectedPrimaryKind
    ? [...windows].reverse().find((window) => window.kind === expectedPrimaryKind)
    // Older Composer specs do not declare `windows` yet. Treat their first
    // authored content window as the primary task surface so an airport
    // question or legacy replay never disappears into the auxiliary layer.
    : [...windows].reverse().find((window) => primaryWindowKinds.has(window.kind))
      ?? legacyNavigationPrimary
      ?? windows.find((window) => window.kind === 'processing' || window.kind === 'error')
  const declaredComponentIds = new Set(windows.flatMap((window) => window.componentIds))
  const phaseComponentType = phasePrimaryComponentType[spec.phase]
  const derivedComponent = phaseComponentType
    ? [...spec.components].reverse().find((component) => (
      component.type === phaseComponentType && !declaredComponentIds.has(component.id)
    ))
    : undefined
  // The cockpit contract uses `windows: []` to say that no auxiliary windows
  // exist. It does not mean the legal UISpec has no primary content: the Agent
  // still owns the flight list/confirmation component in the main layout.
  // Derive a local placement record for that content without inventing any
  // action or changing the server-owned component/action payload.
  const primaryWindow = declaredPrimary ?? (derivedComponent ? {
    id: `primary-${spec.taskId}-${spec.uiRevision}`,
    kind: componentWindowKind(derivedComponent.type, spec.phase),
    title: spec.title,
    componentIds: [derivedComponent.id],
    actionIds: spec.actions.map((action) => action.id),
    size: 'large' as const,
    controls: { closable: false, minimizable: false, maximizable: false },
  } : undefined)
  // Historical main-flow windows can remain declared for audit/replay, but the
  // cockpit presents exactly one current primary step. They are not auxiliary
  // tools and must not reappear as draggable weather-style windows.
  const auxiliaryWindows = windows.filter((window) => window.id !== primaryWindow?.id && !primaryWindowKinds.has(window.kind))

  let mode: CockpitViewMode = 'primary'
  if (isTerminalPhase(spec.phase)) mode = 'terminal'
  else if (isNavigationWorkspacePhase(spec.phase)) mode = 'navigation'

  return { mode, phase: spec.phase, primaryWindow, auxiliaryWindows }
}

const phasePrimaryComponentType: Partial<Record<UISpec['phase'], UISpec['components'][number]['type']>> = {
  'collecting-airport': 'status-banner',
  'choosing-flight': 'flight-choices',
  'confirming-outbound': 'route-confirmation',
  'waiting-for-passengers': 'passenger-status',
  'passengers-onboard': 'passenger-status',
  'confirming-return': 'route-confirmation',
}

function componentWindowKind(type: UISpec['components'][number]['type'], phase?: UISpec['phase']): CockpitWindowSpec['kind'] {
  if (type === 'flight-choices') return 'flight-list'
  if (type === 'route-confirmation') return phase === 'confirming-return' ? 'return-confirmation' : 'outbound-confirmation'
  if (type === 'passenger-status') return 'passenger-onboard'
  if (type === 'alert') return 'error'
  if (type === 'weather-card') return 'weather'
  if (type === 'schedule-card' || type === 'schedule-strip') return 'calendar'
  if (type === 'flight-status') return 'flight-detail'
  return 'processing'
}

export function isPrimaryCockpitWindow(kind: CockpitWindowSpec['kind']): boolean {
  return primaryWindowKinds.has(kind)
}
