import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { RouteSketch, UISpec, VehicleContext } from '@canvasflow/schema'
import { PersistentRouteMap } from './PersistentRouteMap'
import { NavigationHUD } from './NavigationHUD'
import {
  DEFAULT_SIMULATOR_CONFIG,
  createNavigationSimulatorState,
  currentBattery,
  navigationSimulatorReducer,
  pendingManeuverReminder,
  resolveNavigationClock,
  simulatorSnapshot,
  type NavigationClock,
  type NavigationLeg,
  type NavigationSnapshot,
} from './simulator'
import { drivingLegForPhase, type RuntimeNavigationTask } from './contracts'

export type NavigationWorkspaceProps = {
  task: RuntimeNavigationTask
  spec: UISpec
  initialVehicle: VehicleContext
  clock?: NavigationClock
  pending: boolean
  onVehicleSnapshot?: (vehicle: VehicleContext) => void
  onSnapshot?: (snapshot: NavigationSnapshot) => void
  onLegComplete?: (leg: NavigationLeg) => boolean | void | Promise<boolean | void>
  retryLeg?: { leg: NavigationLeg; nonce: number }
  onReminder?: (text: string) => void
  onHudVisibilityChange?: (visible: boolean) => void
}

const OUTBOUND_SKETCH: RouteSketch = {
  waypoints: [
    { name: '当前位置', latitude: 31.23, longitude: 121.47 },
    { name: '机场接人点', latitude: 31.198, longitude: 121.336 },
  ],
  polyline: [
    { latitude: 31.23, longitude: 121.47 },
    { latitude: 31.222, longitude: 121.44 },
    { latitude: 31.21, longitude: 121.39 },
    { latitude: 31.198, longitude: 121.336 },
  ],
}

const RETURN_SKETCH: RouteSketch = {
  waypoints: [
    { name: '机场接人点', latitude: 31.198, longitude: 121.336 },
    { name: '家', latitude: 31.23, longitude: 121.47 },
  ],
  polyline: [...OUTBOUND_SKETCH.polyline].reverse(),
}

export function NavigationWorkspace({
  task,
  spec,
  initialVehicle,
  clock,
  pending,
  onVehicleSnapshot,
  onSnapshot,
  onLegComplete,
  retryLeg,
  onReminder,
  onHudVisibilityChange,
}: NavigationWorkspaceProps) {
  const activeClock = useMemo(() => clock ?? resolveNavigationClock(), [clock])
  const [state, dispatch] = useReducer(navigationSimulatorReducer, activeClock.now(), createNavigationSimulatorState)
  const [nowMs, setNowMs] = useState(activeClock.now)
  const [localHudExpanded, setLocalHudExpanded] = useState(true)
  const [reminderText, setReminderText] = useState<string | undefined>()
  const [retryGeneration, setRetryGeneration] = useState(0)
  const completedLeg = useRef<NavigationLeg | undefined>(undefined)
  const completingLeg = useRef<NavigationLeg | undefined>(undefined)
  const failedLeg = useRef<NavigationLeg | undefined>(undefined)
  const onVehicleSnapshotRef = useRef(onVehicleSnapshot)
  onVehicleSnapshotRef.current = onVehicleSnapshot
  const onSnapshotRef = useRef(onSnapshot)
  onSnapshotRef.current = onSnapshot
  const phaseLeg = drivingLegForPhase(task.phase)
  const routeComponent = spec.components.find((component) => component.type === 'route-map')
  const sourceSketch = routeComponent?.type === 'route-map' ? routeComponent.props.routeSketch : undefined
  const leg = state.simulation?.leg ?? phaseLeg ?? (task.phase === 'return-driving' ? 'return' : 'outbound')
  const sketch = sourceSketch ?? (leg === 'return' ? RETURN_SKETCH : OUTBOUND_SKETCH)
  const destination = leg === 'return' ? '家' : task.pickupAirport?.label ?? task.navigation?.destination ?? '机场接人点'
  const simulatorConfig = useMemo(() => {
    const seed = task.navigationSimulation
    if (!seed) return DEFAULT_SIMULATOR_CONFIG
    const batteryDrop = Math.max(0, seed.initialBatteryPercent - seed.estimatedBatteryAtArrival)
    return {
      distanceKm: { ...DEFAULT_SIMULATOR_CONFIG.distanceKm, [seed.leg]: seed.distanceKm },
      initialBatteryPercent: seed.initialBatteryPercent,
      fullRangeKm: initialVehicle.remainingRangeKm > 0 && initialVehicle.batteryPercent > 0
        ? initialVehicle.remainingRangeKm / (initialVehicle.batteryPercent / 100)
        : DEFAULT_SIMULATOR_CONFIG.fullRangeKm,
      consumptionPercentPerKm: batteryDrop / seed.distanceKm,
      profiles: {
        slow: { durationSeconds: seed.profiles.slow.durationSeconds, speedKph: seed.profiles.slow.displaySpeedKph, label: '慢速' },
        normal: { durationSeconds: seed.profiles.normal.durationSeconds, speedKph: seed.profiles.normal.displaySpeedKph, label: '正常' },
        fast: { durationSeconds: seed.profiles.fast.durationSeconds, speedKph: seed.profiles.fast.displaySpeedKph, label: '快速' },
      },
    }
  }, [initialVehicle.batteryPercent, initialVehicle.remainingRangeKm, task.navigationSimulation])
  const snapshot = useMemo(() => ({
    ...simulatorSnapshot(state, nowMs, simulatorConfig), destination,
  }), [destination, nowMs, simulatorConfig, state])

  useEffect(() => activeClock.schedule(() => {
    const tick = activeClock.now()
    setNowMs(tick)
    dispatch({ type: 'tick', nowMs: tick })
  }), [activeClock])

  useEffect(() => {
    if (!phaseLeg || state.simulation?.leg === phaseLeg) return
    const batteryPercent = task.navigationSimulation?.leg === phaseLeg
      ? task.navigationSimulation.initialBatteryPercent
      : state.simulation ? currentBattery(state, simulatorConfig) : initialVehicle.batteryPercent
    dispatch({
      type: 'start-leg', leg: phaseLeg, nowMs: activeClock.now(), batteryPercent,
      config: simulatorConfig, routeId: task.navigationSimulation?.routeId ?? task.navigation?.routeId,
    })
    completedLeg.current = undefined
    completingLeg.current = undefined
    failedLeg.current = undefined
  }, [activeClock, initialVehicle.batteryPercent, phaseLeg, simulatorConfig, state, task.navigation?.routeId, task.navigationSimulation])

  useEffect(() => {
    const speedTier = task.cockpit?.speedMode
    if (!speedTier || speedTier === state.simulation?.speedMode || state.simulation?.arrived !== false) return
    dispatch({ type: 'set-speed', speedTier, nowMs: activeClock.now() })
  }, [activeClock, state.simulation?.arrived, state.simulation?.speedMode, task.cockpit?.speedMode])

  useEffect(() => {
    onSnapshotRef.current?.(snapshot)
    onVehicleSnapshotRef.current?.({
      ...initialVehicle,
      speedKph: snapshot.speedKph,
      batteryPercent: snapshot.batteryPercent,
      remainingRangeKm: snapshot.remainingRangeKm,
      gear: snapshot.runState === 'driving' ? 'D' : 'P',
    })
  }, [initialVehicle, snapshot])

  useEffect(() => {
    if (snapshot.runState !== 'arrived' || !snapshot.leg
      || completedLeg.current === snapshot.leg || completingLeg.current === snapshot.leg || failedLeg.current === snapshot.leg) return
    const arrivingLeg = snapshot.leg
    if (!onLegComplete) {
      completedLeg.current = arrivingLeg
      return
    }
    completingLeg.current = arrivingLeg
    void Promise.resolve(onLegComplete(arrivingLeg)).then(
      (completed) => {
        if (completed !== false) completedLeg.current = arrivingLeg
        else failedLeg.current = arrivingLeg
        completingLeg.current = undefined
      },
      () => {
        failedLeg.current = arrivingLeg
        completingLeg.current = undefined
      },
    )
  }, [nowMs, onLegComplete, retryGeneration, snapshot.leg, snapshot.runState])

  useEffect(() => {
    if (!retryLeg || retryLeg.leg !== snapshot.leg || snapshot.runState !== 'arrived') return
    failedLeg.current = undefined
    completingLeg.current = undefined
    completedLeg.current = undefined
    setRetryGeneration((current) => current + 1)
  }, [retryLeg, snapshot.leg, snapshot.runState])

  useEffect(() => {
    const reminder = pendingManeuverReminder(state, snapshot)
    if (!reminder) return
    dispatch({ type: 'mark-reminded', maneuverId: reminder.id })
    setReminderText(reminder.text)
    onReminder?.(reminder.text)
  }, [onReminder, snapshot, state])

  return (
    <section className="navigation-workspace" data-session-key={task.taskId} data-leg={leg} data-pending={pending}>
      <PersistentRouteMap
        sessionKey={task.taskId}
        routeKey={`${leg}:${task.navigation?.routeId ?? leg}`}
        destination={destination}
        progress={snapshot.progress}
        sketch={sketch}
        theme={spec.presentation.theme}
        progressLabel={`模拟行程进度 ${Math.round(snapshot.progress * 100)}%`}
      />
      <div className="navigation-workspace__brand" aria-label="pilotflow 模拟导航">
        <strong>pilotflow</strong><span>模拟导航</span>
      </div>
      <NavigationHUD
        snapshot={snapshot}
        flight={task.flight}
        alert={reminderText}
        expanded={task.cockpit?.hudVisible ?? localHudExpanded}
        speedTierLabel={simulatorConfig.profiles[snapshot.speedTier].label}
        onToggle={() => {
          const visible = !(task.cockpit?.hudVisible ?? localHudExpanded)
          if (onHudVisibilityChange) onHudVisibilityChange(visible)
          else setLocalHudExpanded(visible)
        }}
      />
    </section>
  )
}

export type { NavigationSnapshot }
