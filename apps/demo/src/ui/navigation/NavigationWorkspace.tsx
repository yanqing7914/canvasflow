import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { RouteSketch, UISpec, VehicleContext } from '@canvasflow/schema'
import { PersistentRouteMap } from './PersistentRouteMap'
import { NavigationHUD } from './NavigationHUD'
import { WindowManager } from './WindowManager'
import {
  DEFAULT_SIMULATOR_CONFIG,
  browserNavigationClock,
  createNavigationSimulatorState,
  currentBattery,
  navigationSimulatorReducer,
  pendingManeuverReminder,
  simulatorSnapshot,
  type NavigationClock,
  type NavigationLeg,
  type NavigationSnapshot,
} from './simulator'
import { drivingLegForPhase, runtimeWindows, type RuntimeNavigationTask } from './contracts'

export type NavigationWorkspaceProps = {
  task: RuntimeNavigationTask
  spec: UISpec
  initialVehicle: VehicleContext
  clock?: NavigationClock
  pending: boolean
  onAction: (actionId: string, componentId: string) => void
  onVehicleSnapshot?: (vehicle: VehicleContext) => void
  onLegComplete?: (leg: NavigationLeg) => void
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
  clock = browserNavigationClock,
  pending,
  onAction,
  onVehicleSnapshot,
  onLegComplete,
  onReminder,
  onHudVisibilityChange,
}: NavigationWorkspaceProps) {
  const [state, dispatch] = useReducer(navigationSimulatorReducer, clock.now(), createNavigationSimulatorState)
  const [nowMs, setNowMs] = useState(clock.now)
  const [localHudExpanded, setLocalHudExpanded] = useState(true)
  const [reminderText, setReminderText] = useState<string>()
  const completedLeg = useRef<NavigationLeg | undefined>(undefined)
  const onVehicleSnapshotRef = useRef(onVehicleSnapshot)
  onVehicleSnapshotRef.current = onVehicleSnapshot
  const phaseLeg = drivingLegForPhase(task.phase)
  const routeComponent = spec.components.find((component) => component.type === 'route-map')
  const sourceSketch = routeComponent?.type === 'route-map' ? routeComponent.props.routeSketch : undefined
  const leg = state.leg ?? phaseLeg ?? (task.phase === 'return-driving' ? 'return' : 'outbound')
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

  useEffect(() => clock.schedule(() => {
    const tick = clock.now()
    setNowMs(tick)
    dispatch({
      type: 'tick', nowMs: tick,
      durationSeconds: simulatorConfig.profiles[state.speedTier].durationSeconds,
    })
  }), [clock, simulatorConfig.profiles, state.speedTier])

  useEffect(() => {
    if (!phaseLeg || state.leg === phaseLeg) return
    const batteryPercent = task.navigationSimulation?.leg === phaseLeg
      ? task.navigationSimulation.initialBatteryPercent
      : state.leg ? currentBattery(state, simulatorConfig) : initialVehicle.batteryPercent
    dispatch({ type: 'start-leg', leg: phaseLeg, nowMs: clock.now(), batteryPercent })
    completedLeg.current = undefined
  }, [clock, initialVehicle.batteryPercent, phaseLeg, simulatorConfig, state, task.navigationSimulation])

  useEffect(() => {
    const speedTier = task.cockpit?.speedMode
    if (!speedTier || speedTier === state.speedTier || state.runState !== 'driving') return
    dispatch({
      type: 'set-speed', speedTier, nowMs: clock.now(),
      currentDurationSeconds: simulatorConfig.profiles[state.speedTier].durationSeconds,
    })
  }, [clock, simulatorConfig.profiles, state.runState, state.speedTier, task.cockpit?.speedMode])

  useEffect(() => {
    onVehicleSnapshotRef.current?.({
      ...initialVehicle,
      speedKph: snapshot.speedKph,
      batteryPercent: snapshot.batteryPercent,
      remainingRangeKm: snapshot.remainingRangeKm,
      gear: snapshot.runState === 'driving' ? 'D' : 'P',
    })
  }, [initialVehicle, snapshot.batteryPercent, snapshot.remainingRangeKm, snapshot.runState, snapshot.speedKph])

  useEffect(() => {
    if (snapshot.runState !== 'arrived' || !snapshot.leg || completedLeg.current === snapshot.leg) return
    completedLeg.current = snapshot.leg
    onLegComplete?.(snapshot.leg)
  }, [onLegComplete, snapshot.leg, snapshot.runState])

  useEffect(() => {
    const reminder = pendingManeuverReminder(state, snapshot)
    if (!reminder) return
    dispatch({ type: 'mark-reminded', maneuverId: reminder.id })
    setReminderText(reminder.text)
    onReminder?.(reminder.text)
  }, [onReminder, snapshot, state])

  return (
    <section className="navigation-workspace" data-session-key={task.taskId} data-leg={leg}>
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
      <WindowManager
        spec={spec}
        pending={pending}
        driving={snapshot.runState === 'driving'}
        vehicle={snapshot}
        onAction={onAction}
        clear={task.phase === 'completed'}
        preserveMissing={runtimeWindows(spec).length === 0}
      />
    </section>
  )
}

export type { NavigationSnapshot }
