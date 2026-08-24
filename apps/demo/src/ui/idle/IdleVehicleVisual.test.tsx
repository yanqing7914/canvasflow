import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdleVehicleVisual } from './IdleVehicleVisual'

vi.mock('@google/model-viewer', () => ({}))

const webGLRenderingContext = Object.getOwnPropertyDescriptor(window, 'WebGLRenderingContext')
const webGL2RenderingContext = Object.getOwnPropertyDescriptor(window, 'WebGL2RenderingContext')
const requestIdleCallback = Object.getOwnPropertyDescriptor(window, 'requestIdleCallback')
const cancelIdleCallback = Object.getOwnPropertyDescriptor(window, 'cancelIdleCallback')

function restoreWebGLProperty(name: 'WebGLRenderingContext' | 'WebGL2RenderingContext', descriptor?: PropertyDescriptor) {
  if (descriptor) Object.defineProperty(window, name, descriptor)
  else delete (window as unknown as Record<string, unknown>)[name]
}

function restoreIdleCallback(name: 'requestIdleCallback' | 'cancelIdleCallback', descriptor?: PropertyDescriptor) {
  if (descriptor) Object.defineProperty(window, name, descriptor)
  else delete (window as unknown as Record<string, unknown>)[name]
}

describe('IdleVehicleVisual', () => {
  beforeEach(() => {
    class TestModelViewer extends HTMLElement {}
    if (!window.customElements.get('model-viewer')) window.customElements.define('model-viewer', TestModelViewer)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    restoreWebGLProperty('WebGLRenderingContext', webGLRenderingContext)
    restoreWebGLProperty('WebGL2RenderingContext', webGL2RenderingContext)
    restoreIdleCallback('requestIdleCallback', requestIdleCallback)
    restoreIdleCallback('cancelIdleCallback', cancelIdleCallback)
  })

  it('loads the locally hosted model viewer with accessible manual drag controls', async () => {
    Object.defineProperty(window, 'requestIdleCallback', { configurable: true, value: undefined })
    Object.defineProperty(window, 'cancelIdleCallback', { configurable: true, value: undefined })
    Object.defineProperty(window, 'WebGLRenderingContext', { configurable: true, value: class WebGLRenderingContext {} })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as WebGLRenderingContext)

    render(<IdleVehicleVisual />)
    await act(async () => { await Promise.resolve() })

    const model = screen.getByTestId('idle-vehicle-model')
    expect(model).toHaveAttribute('src', '/car/idle-ev-concept.glb')
    expect(model).toHaveAttribute('alt', '深银色纯电概念车的可交互三维模型')
    expect(model).toHaveAttribute('aria-label', '深银色纯电概念车三维模型，可拖动旋转查看')
    expect(model).toHaveAttribute('camera-controls')
    expect(model).not.toHaveAttribute('auto-rotate')
    expect(model).not.toHaveAttribute('auto-rotate-delay')
    expect(model).not.toHaveAttribute('rotation-per-second')
    expect(model).toHaveAttribute('variant-name', 'Torched Graphite')
    expect(model).toHaveAttribute('camera-orbit', '-35deg 70deg 78%')
    expect(model).toHaveAttribute('camera-target', '0m 0.57m 0.24m')
    expect(model).toHaveAttribute('field-of-view', '30deg')
    expect(model).toHaveAttribute('min-camera-orbit', '-115deg 62deg 76%')
    expect(model).toHaveAttribute('max-camera-orbit', '45deg 78deg 108%')
    expect(model.getAttribute('min-camera-orbit')).not.toMatch(/auto\s+auto/)
    expect(model.getAttribute('max-camera-orbit')).not.toMatch(/auto\s+auto/)
    expect(model).toHaveAttribute('disable-zoom')
    expect(model).toHaveAttribute('disable-pan')
    expect(model).toHaveAttribute('shadow-intensity', '0.8')
    expect(model).toHaveAttribute('shadow-softness', '1')
    expect(model).toHaveAttribute('exposure', '1.05')
    expect(model).toHaveAttribute('touch-action', 'pan-y')

    await act(async () => {
      fireEvent(model, new Event('error'))
      await Promise.resolve()
    })
    expect(screen.getByTestId('idle-vehicle-fallback')).toHaveAttribute('src', '/car/idle-car-ev.png')
    expect(screen.getByTestId('idle-vehicle-fallback-status')).toHaveTextContent('三维车辆暂不可用，已切换为本地静态车辆展示。')
  })

  it('keeps the local PNG when WebGL is unavailable', async () => {
    Object.defineProperty(window, 'requestIdleCallback', { configurable: true, value: undefined })
    Object.defineProperty(window, 'cancelIdleCallback', { configurable: true, value: undefined })
    Object.defineProperty(window, 'WebGLRenderingContext', { configurable: true, value: undefined })
    Object.defineProperty(window, 'WebGL2RenderingContext', { configurable: true, value: undefined })

    render(<IdleVehicleVisual />)
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByTestId('idle-vehicle-model')).not.toBeInTheDocument()
    expect(screen.getByTestId('idle-vehicle-fallback-status')).toHaveTextContent('三维车辆暂不可用，已切换为本地静态车辆展示。')
  })
})
