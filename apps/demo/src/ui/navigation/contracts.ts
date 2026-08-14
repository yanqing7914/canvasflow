import type { ActionSpec, ComponentSpec, UISpec } from '@canvasflow/schema'

export const cockpitWindowKinds = [
  'flight-list',
  'outbound-confirmation',
  'weather',
  'charging',
  'calendar',
  'flight-detail',
  'passenger-onboard',
  'return-confirmation',
  'vehicle-status',
  'processing',
  'error',
] as const

export type CockpitWindowKind = (typeof cockpitWindowKinds)[number]

export type CockpitWindowSpec = {
  id: string
  kind: CockpitWindowKind
  title: string
  componentIds: string[]
  actionIds?: string[]
  size: 'compact' | 'medium' | 'large'
  controls: {
    closable: boolean
    minimizable: boolean
    maximizable: boolean
  }
}

export type CockpitUISpec = UISpec & { windows?: CockpitWindowSpec[] }

export type NavigationPhase =
  | UISpec['phase']
  | 'collecting-airport'
  | 'choosing-flight'
  | 'confirming-outbound'
  | 'outbound-driving'
  | 'passengers-onboard'
  | 'confirming-return'
  | 'return-driving'

export type RuntimePickupAirport = { label: string; code?: string }

export type RuntimeFlight = {
  flightNumber: string
  airlineName?: string
  originName?: string
  status?: string
  statusLabel?: string
  scheduledArrival?: string
  estimatedArrival: string
  terminal: string
  arrivalAirport?: string
  arrivalAirportName?: string
}

export type RuntimeNavigationTask = {
  taskId: string
  phase: NavigationPhase
  pickupAirport?: RuntimePickupAirport
  flight?: RuntimeFlight
  navigation?: {
    routeId: string
    destination: string
    eta: string
    status: 'planned' | 'active' | 'arrived'
  }
  navigationSimulation?: {
    leg: 'outbound' | 'return'
    routeId: string
    distanceKm: number
    initialBatteryPercent: number
    estimatedBatteryAtArrival: number
    profiles: Record<'slow' | 'normal' | 'fast', {
      durationSeconds: number
      displaySpeedKph: number
    }>
  }
  cockpit?: {
    speedMode: 'slow' | 'normal' | 'fast'
    hudVisible: boolean
    activeLeg?: 'outbound' | 'return'
    routeProgress?: number
    currentRoad?: string
  }
}

const windowKindSet = new Set<string>(cockpitWindowKinds)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return undefined
  return value as string[]
}

export function runtimeWindows(spec: UISpec): CockpitWindowSpec[] {
  const raw = (spec as unknown as { windows?: unknown }).windows
  if (!Array.isArray(raw)) return []
  const parsed: CockpitWindowSpec[] = []
  for (const candidate of raw) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || candidate.id.length === 0) continue
    if (typeof candidate.kind !== 'string' || !windowKindSet.has(candidate.kind)) continue
    if (typeof candidate.title !== 'string' || candidate.title.length === 0) continue
    const componentIds = strings(candidate.componentIds)
    const actionIds = candidate.actionIds === undefined ? undefined : strings(candidate.actionIds)
    if (!componentIds || (candidate.actionIds !== undefined && !actionIds)) continue
    if (candidate.size !== 'compact' && candidate.size !== 'medium' && candidate.size !== 'large') continue
    if (!isRecord(candidate.controls)) continue
    const { closable, minimizable, maximizable } = candidate.controls
    if (typeof closable !== 'boolean' || typeof minimizable !== 'boolean' || typeof maximizable !== 'boolean') continue
    parsed.push({
      id: candidate.id,
      kind: candidate.kind as CockpitWindowKind,
      title: candidate.title,
      componentIds,
      ...(actionIds ? { actionIds } : {}),
      size: candidate.size,
      controls: { closable, minimizable, maximizable },
    })
  }
  return parsed
}

export function workspaceWindows(spec: UISpec): CockpitWindowSpec[] {
  const rawWindows = (spec as unknown as { windows?: unknown }).windows
  const declared = runtimeWindows(spec)
  // An explicit empty list is a server-owned statement that no auxiliary
  // windows exist. Only synthesize a legacy window when the field is absent.
  if (Array.isArray(rawWindows)) return declared
  const componentIds = spec.components
    .filter((component) => component.type !== 'route-map')
    .map((component) => component.id)
  if (componentIds.length === 0) return []
  return [{
    id: `legacy-${spec.taskId}-${spec.uiRevision}`,
    kind: legacyWindowKind(spec.components.find((component) => componentIds.includes(component.id))?.type),
    title: spec.title,
    componentIds,
    actionIds: spec.actions.map((action) => action.id),
    size: componentIds.length > 1 ? 'large' : 'medium',
    controls: { closable: true, minimizable: true, maximizable: true },
  }]
}

function legacyWindowKind(type: ComponentSpec['type'] | undefined): CockpitWindowKind {
  if (type === 'flight-choices') return 'flight-list'
  if (type === 'weather-card') return 'weather'
  if (type === 'charging-recommendation') return 'charging'
  if (type === 'schedule-card' || type === 'schedule-strip') return 'calendar'
  if (type === 'passenger-status') return 'passenger-onboard'
  if (type === 'alert') return 'error'
  if (type === 'status-banner') return 'processing'
  if (type === 'flight-status') return 'flight-detail'
  return 'processing'
}

export function windowUISpec(spec: UISpec, window: CockpitWindowSpec): UISpec {
  const baseSpec: CockpitUISpec = { ...spec }
  delete baseSpec.windows
  const componentIds = new Set(window.componentIds)
  const components = spec.components.filter((component) => componentIds.has(component.id))
  const componentActionIds = new Set(components.flatMap((component) => component.actions ?? []))
  const requestedActionIds = new Set(window.actionIds ?? [])
  const actions = spec.actions.filter((action) => (
    componentActionIds.has(action.id) || requestedActionIds.has(action.id)
  ))
  return {
    ...baseSpec,
    title: window.title,
    layout: { type: 'stack', gap: 'sm', slots: { main: components.map((component) => component.id) } },
    components,
    actions,
  }
}

export function componentById(spec: UISpec, id: string): ComponentSpec | undefined {
  return spec.components.find((component) => component.id === id)
}

export function actionById(spec: UISpec, id: string): ActionSpec | undefined {
  return spec.actions.find((action) => action.id === id)
}

export function navigationPhase(phase: string): boolean {
  return phase === 'driving-to-airport'
    || phase === 'approaching-airport'
    || phase === 'returning-home'
    || phase === 'outbound-driving'
    || phase === 'passengers-onboard'
    || phase === 'confirming-return'
    || phase === 'return-driving'
}

export function cockpitContractPhase(phase: string): boolean {
  return phase === 'collecting-airport'
    || phase === 'choosing-flight'
    || phase === 'confirming-outbound'
    || phase === 'outbound-driving'
    || phase === 'waiting-for-passengers'
    || phase === 'passengers-onboard'
    || phase === 'confirming-return'
    || phase === 'return-driving'
}

export function drivingLegForPhase(phase: string): 'outbound' | 'return' | undefined {
  if (phase === 'driving-to-airport' || phase === 'approaching-airport' || phase === 'outbound-driving') {
    return 'outbound'
  }
  if (phase === 'returning-home' || phase === 'return-driving') return 'return'
  return undefined
}
