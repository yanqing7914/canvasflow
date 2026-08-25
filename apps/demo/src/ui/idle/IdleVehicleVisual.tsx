import { createElement, useCallback, useEffect, useRef, useState } from 'react'

const MODEL_SRC = '/car/idle-ev-concept.glb'
const FALLBACK_SRC = '/car/idle-car-ev.png'
const FALLBACK_MESSAGE = '三维车辆暂不可用，已切换为本地静态车辆展示。'

function supportsWebGL() {
  if (typeof window === 'undefined' || (!window.WebGLRenderingContext && !window.WebGL2RenderingContext)) return false

  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl'))
  } catch {
    return false
  }
}

/**
 * Keep the 3D renderer optional: an unavailable WebGL runtime never leaves the
 * idle screen without its locally bundled vehicle visual.
 */
export function IdleVehicleVisual({ muted = false }: { muted?: boolean }) {
  // Mount the real model on the first frame. The static image is an error
  // fallback only, so a fresh page never flashes the legacy vehicle first.
  const [renderer, setRenderer] = useState<'model-viewer' | 'fallback'>('model-viewer')
  const [fallbackStatusVisible, setFallbackStatusVisible] = useState(false)
  const modelViewerRef = useRef<HTMLElement | null>(null)
  const showFallback = useCallback(() => {
    setRenderer('fallback')
    setFallbackStatusVisible(true)
  }, [])

  useEffect(() => {
    let disposed = false

    async function loadModelViewer() {
      try {
        if (!supportsWebGL() || !window.customElements) throw new Error('WebGL is unavailable')
        // Register the custom element only after this visual is mounted.
        await import('@google/model-viewer')
        await window.customElements.whenDefined('model-viewer')
        if (!disposed && window.customElements.get('model-viewer')) setRenderer('model-viewer')
      } catch {
        if (!disposed) showFallback()
      }
    }

    void loadModelViewer()
    return () => {
      disposed = true
    }
  }, [showFallback])

  useEffect(() => {
    if (renderer !== 'model-viewer' || !modelViewerRef.current) return

    const modelViewer = modelViewerRef.current
    // model-viewer emits error for failed assets and re-emits WebGL failures.
    modelViewer.addEventListener('error', showFallback)
    modelViewer.addEventListener('webglcontextlost', showFallback)
    return () => {
      modelViewer.removeEventListener('error', showFallback)
      modelViewer.removeEventListener('webglcontextlost', showFallback)
    }
  }, [renderer, showFallback])

  const isModelViewer = renderer === 'model-viewer'

  return (
    <div
      className={`idle-vehicle-visual${muted ? ' idle-vehicle-visual--muted' : ''}`}
      data-testid="idle-vehicle-visual"
      data-renderer={isModelViewer ? 'model-viewer' : renderer}
    >
      <span className="idle-vehicle-visual__reflection" data-testid="idle-vehicle-reflection" aria-hidden="true" />
      <span className="idle-vehicle-visual__ground" data-testid="idle-vehicle-ground" aria-hidden="true" />
      {isModelViewer
        ? createElement('model-viewer', {
          ref: modelViewerRef,
          className: 'idle-vehicle-visual__model',
          'data-testid': 'idle-vehicle-model',
          src: MODEL_SRC,
          alt: '深银色纯电概念车的可交互三维模型',
          'aria-label': '深银色纯电概念车三维模型，可拖动旋转查看',
          role: 'img',
          tabIndex: 0,
          'camera-controls': '',
          // Select the neutral graphite variant instead of the source's red
          // showroom default. The model keeps its PBR paint, glass, and light
          // materials while staying visually quiet behind the cockpit cards.
          'variant-name': 'Torched Graphite',
          // Lock the opening view to a composed front three-quarter angle while
          // leaving the vehicle free to orbit horizontally under direct drag.
          'camera-orbit': '-35deg 70deg 78%',
          'camera-target': '0m 0.57m 0.24m',
          'field-of-view': '30deg',
          // Keep the car in a grounded three-quarter presentation. The
          // explicit polar bounds prevent drag gestures from reaching the
          // roof or underside while the azimuth range still allows both
          // side views.
          // Keep useful front/side views while clamping vertical pitch and
          // leaving enough camera distance for the full vehicle to fit.
          'min-camera-orbit': '-115deg 66deg 76%',
          'max-camera-orbit': '45deg 74deg 96%',
          'disable-zoom': '',
          'disable-pan': '',
          'shadow-intensity': '0.8',
          'shadow-softness': '1',
          exposure: '1.05',
          'interaction-prompt': 'none',
          // Vertical gestures still scroll the mobile idle screen; horizontal drags orbit.
          'touch-action': 'pan-y',
          loading: 'eager',
          onError: showFallback,
        })
        : (
          <img
            className="idle-vehicle-visual__fallback"
            data-testid="idle-vehicle-fallback"
            src={FALLBACK_SRC}
            alt=""
            width={1617}
            height={676}
            draggable={false}
          />
        )}
      {fallbackStatusVisible
        ? <span className="sr-only" data-testid="idle-vehicle-fallback-status" aria-live="polite">{FALLBACK_MESSAGE}</span>
        : null}
    </div>
  )
}
