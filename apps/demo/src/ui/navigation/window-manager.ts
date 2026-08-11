import type { CockpitWindowSpec } from './contracts'

export type WindowMode = 'normal' | 'minimized' | 'maximized'

export type ManagedWindow = {
  spec: CockpitWindowSpec
  x: number
  y: number
  zIndex: number
  mode: WindowMode
  restoreMode: Exclude<WindowMode, 'maximized'>
}

export type WindowManagerState = {
  windows: ManagedWindow[]
  tombstones: string[]
  nextZIndex: number
  announcement: string
}

export type WindowViewport = { width: number; height: number }

export type WindowManagerAction =
  | { type: 'sync'; specs: CockpitWindowSpec[]; viewport: WindowViewport; preserveMissing?: boolean }
  | { type: 'focus'; id: string }
  | { type: 'move'; id: string; x: number; y: number; viewport: WindowViewport }
  | { type: 'minimize'; id: string }
  | { type: 'restore'; id: string }
  | { type: 'toggle-maximize'; id: string }
  | { type: 'close'; id: string }
  | { type: 'clear' }

const WINDOW_WIDTHS = { compact: 360, medium: 440, large: 560 } as const
const WINDOW_HEIGHTS = { compact: 320, medium: 500, large: 650 } as const
const VIEWPORT_MARGIN = 16
const DEFAULT_TOP = 84

export function createWindowManagerState(): WindowManagerState {
  return { windows: [], tombstones: [], nextZIndex: 20, announcement: '' }
}

export function managedWindowSize(spec: CockpitWindowSpec): { width: number; height: number } {
  return { width: WINDOW_WIDTHS[spec.size], height: WINDOW_HEIGHTS[spec.size] }
}

export function windowManagerReducer(
  state: WindowManagerState,
  action: WindowManagerAction,
): WindowManagerState {
  switch (action.type) {
    case 'sync': {
      let nextZIndex = state.nextZIndex
      const existing = new Map(state.windows.map((window) => [window.spec.id, window]))
      const additions: ManagedWindow[] = []
      for (const spec of action.specs) {
        if (state.tombstones.includes(spec.id)) continue
        const current = existing.get(spec.id)
        if (current) {
          existing.set(spec.id, { ...current, spec })
          continue
        }
        nextZIndex += 1
        const size = managedWindowSize(spec)
        additions.push({
          spec,
          x: Math.max(VIEWPORT_MARGIN, action.viewport.width - size.width - 24),
          y: Math.min(DEFAULT_TOP, Math.max(VIEWPORT_MARGIN, action.viewport.height - 72)),
          zIndex: nextZIndex,
          mode: 'normal',
          restoreMode: 'normal',
        })
      }
      const incomingIds = new Set(action.specs.map((spec) => spec.id))
      const retained = action.preserveMissing === false
        ? state.windows.filter((window) => incomingIds.has(window.spec.id))
        : state.windows
      const updated = retained.map((window) => existing.get(window.spec.id) ?? window)
      const newest = additions.at(-1)
      return {
        ...state,
        windows: [...updated, ...additions],
        nextZIndex,
        announcement: newest ? `已打开${newest.spec.title}窗口` : state.announcement,
      }
    }
    case 'focus':
      if (!state.windows.some((window) => window.spec.id === action.id)) return state
      return withWindow(state, action.id, (window, zIndex) => ({ ...window, zIndex }), '')
    case 'move':
      return updateWindow(state, action.id, (window) => {
        const size = managedWindowSize(window.spec)
        return {
          ...window,
          x: clamp(action.x, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, action.viewport.width - size.width - VIEWPORT_MARGIN)),
          y: clamp(action.y, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, action.viewport.height - 56)),
        }
      })
    case 'minimize':
      return updateWindow(state, action.id, (window) => ({ ...window, mode: 'minimized', restoreMode: 'normal' }), '窗口已最小化')
    case 'restore':
      return updateWindow(state, action.id, (window) => ({ ...window, mode: window.restoreMode }), '窗口已恢复')
    case 'toggle-maximize':
      return updateWindow(state, action.id, (window) => window.mode === 'maximized'
        ? { ...window, mode: window.restoreMode }
        : { ...window, restoreMode: window.mode === 'minimized' ? 'minimized' : 'normal', mode: 'maximized' }, '窗口显示方式已更新')
    case 'close': {
      const closing = state.windows.find((window) => window.spec.id === action.id)
      if (!closing) return state
      return {
        ...state,
        windows: state.windows.filter((window) => window.spec.id !== action.id),
        tombstones: state.tombstones.includes(action.id) ? state.tombstones : [...state.tombstones, action.id],
        announcement: `已关闭${closing.spec.title}窗口`,
      }
    }
    case 'clear':
      return createWindowManagerState()
  }
}

function withWindow(
  state: WindowManagerState,
  id: string,
  update: (window: ManagedWindow, zIndex: number) => ManagedWindow,
  announcement: string,
): WindowManagerState {
  const nextZIndex = state.nextZIndex + 1
  return {
    ...state,
    windows: state.windows.map((window) => window.spec.id === id ? update(window, nextZIndex) : window),
    nextZIndex,
    announcement,
  }
}

function updateWindow(
  state: WindowManagerState,
  id: string,
  update: (window: ManagedWindow) => ManagedWindow,
  announcement = state.announcement,
): WindowManagerState {
  if (!state.windows.some((window) => window.spec.id === id)) return state
  return {
    ...state,
    windows: state.windows.map((window) => window.spec.id === id ? update(window) : window),
    announcement,
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
