import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

export type CockpitToolWindowMode = 'normal' | 'minimized'

export type CockpitToolWindowHandle = {
  focusOrRestore: () => void
}

export type CockpitToolWindowProps = {
  open: boolean
  title: string
  onClose: () => void
  onModeChange?: (mode: CockpitToolWindowMode) => void
  children: ReactNode
  id?: string
}

type Position = { x: number; y: number }
type DragState = { startX: number; startY: number; originX: number; originY: number }

const WINDOW_WIDTH = 430
const TABLET_WINDOW_WIDTH = 340
const VIEWPORT_GUTTER = 12
const DEFAULT_TOP = 72
const NARROW_BREAKPOINT = 720
const TABLET_BREAKPOINT = 900
const ENTRY_GAP = 10
const MIN_NORMAL_HEIGHT = 320

function defaultPosition(): Position {
  const width = window.innerWidth <= TABLET_BREAKPOINT && window.innerWidth > NARROW_BREAKPOINT
    ? TABLET_WINDOW_WIDTH
    : WINDOW_WIDTH
  return {
    x: Math.max(VIEWPORT_GUTTER, window.innerWidth - width - 24),
    y: DEFAULT_TOP,
  }
}

function bottomBoundary(node?: HTMLElement | null): number {
  const workspace = node?.closest<HTMLElement>('[data-cockpit-workspace]')
  const entry = workspace?.querySelector<HTMLElement>('[data-cockpit-slot="entry"]')
  const entryTop = entry?.getBoundingClientRect().top
  return entryTop && entryTop > VIEWPORT_GUTTER
    ? entryTop - ENTRY_GAP
    : window.innerHeight - VIEWPORT_GUTTER
}

function clampPosition(position: Position, width: number, height: number, node?: HTMLElement | null): Position {
  return {
    x: Math.min(Math.max(VIEWPORT_GUTTER, position.x), Math.max(VIEWPORT_GUTTER, window.innerWidth - width - VIEWPORT_GUTTER)),
    y: Math.min(Math.max(VIEWPORT_GUTTER, position.y), Math.max(VIEWPORT_GUTTER, bottomBoundary(node) - height)),
  }
}

function boundedHeight(height: number, mode: CockpitToolWindowMode, normalHeight: number): number {
  return mode === 'normal' ? Math.max(MIN_NORMAL_HEIGHT, normalHeight, height) : height
}

export const CockpitToolWindow = forwardRef<CockpitToolWindowHandle, CockpitToolWindowProps>(function CockpitToolWindow({
  open,
  title,
  onClose,
  onModeChange,
  children,
  id = 'demo-controls-tool-window',
}, forwardedRef) {
  const titleId = useId()
  const windowRef = useRef<HTMLElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const wasOpen = useRef(false)
  const drag = useRef<DragState | undefined>(undefined)
  const normalHeight = useRef(MIN_NORMAL_HEIGHT)
  const [mode, setMode] = useState<CockpitToolWindowMode>('normal')
  const [position, setPosition] = useState(defaultPosition)
  const [contentHost] = useState(() => document.createElement('div'))

  function updateMode(next: CockpitToolWindowMode) {
    setMode(next)
    onModeChange?.(next)
  }

  useImperativeHandle(forwardedRef, () => ({
    focusOrRestore() {
      if (mode === 'minimized') updateMode('normal')
      windowRef.current?.focus()
    },
  }))

  useLayoutEffect(() => {
    const body = bodyRef.current
    if (open && mode === 'normal' && body) {
      body.append(contentHost)
      return () => { contentHost.remove() }
    }
    contentHost.remove()
  }, [contentHost, mode, open])

  useLayoutEffect(() => {
    const node = windowRef.current
    if (!open || !node || window.innerWidth <= NARROW_BREAKPOINT) return
    const rect = node.getBoundingClientRect()
    if (mode === 'normal') normalHeight.current = Math.max(normalHeight.current, rect.height)
    setPosition((current) => clampPosition(
      current,
      rect.width || WINDOW_WIDTH,
      boundedHeight(rect.height, mode, normalHeight.current),
      node,
    ))
  }, [mode, open])

  useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      windowRef.current?.focus()
    } else if (!open && wasOpen.current) {
      previousFocus.current?.focus()
    }
    wasOpen.current = open
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, open])

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const active = drag.current
      const node = windowRef.current
      if (!active || !node) return
      const rect = node.getBoundingClientRect()
      setPosition(clampPosition({
        x: active.originX + event.clientX - active.startX,
        y: active.originY + event.clientY - active.startY,
      }, rect.width || WINDOW_WIDTH, boundedHeight(rect.height, mode, normalHeight.current), node))
    }
    const stopDragging = () => { drag.current = undefined }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', stopDragging)
    window.addEventListener('pointercancel', stopDragging)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', stopDragging)
      window.removeEventListener('pointercancel', stopDragging)
    }
  }, [mode])

  useEffect(() => {
    const onResize = () => {
      const node = windowRef.current
      if (!node || node.hidden || window.innerWidth <= NARROW_BREAKPOINT) return
      const rect = node.getBoundingClientRect()
      setPosition((current) => clampPosition(
        current,
        rect.width || WINDOW_WIDTH,
        boundedHeight(rect.height, mode, normalHeight.current),
        node,
      ))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [mode])

  function startDragging(event: ReactPointerEvent<HTMLElement>) {
    if (window.innerWidth <= NARROW_BREAKPOINT || event.button !== 0 || (event.target as HTMLElement).closest('button')) return
    drag.current = { startX: event.clientX, startY: event.clientY, originX: position.x, originY: position.y }
  }

  const style = {
    '--tool-window-x': `${position.x}px`,
    '--tool-window-y': `${position.y}px`,
  } as CSSProperties

  return (
    <article
      ref={windowRef}
      id={id}
      className="cockpit-tool-window"
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      hidden={!open}
      data-mode={mode}
      style={style}
      onPointerDown={() => windowRef.current?.focus()}
    >
      <header
        className="cockpit-window__chrome cockpit-tool-window__chrome"
        data-testid="cockpit-tool-window-titlebar"
        onPointerDown={startDragging}
      >
        <span className="cockpit-window__signal" aria-hidden="true" />
        <h2 id={titleId}>{title}</h2>
        <div className="cockpit-window__controls">
          <button
            type="button"
            aria-label={mode === 'minimized' ? `恢复${title}窗口` : `最小化${title}窗口`}
            onClick={() => updateMode(mode === 'minimized' ? 'normal' : 'minimized')}
          >
            <span aria-hidden="true">{mode === 'minimized' ? '□' : '−'}</span>
          </button>
          <button type="button" aria-label={`关闭${title}窗口`} onClick={onClose}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
      </header>
      <div ref={bodyRef} className="cockpit-window__body cockpit-tool-window__body" hidden={!open || mode === 'minimized'} />
      {createPortal(children, contentHost)}
    </article>
  )
})

export default CockpitToolWindow
