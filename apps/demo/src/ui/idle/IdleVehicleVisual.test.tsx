import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdleVehicleVisual } from './IdleVehicleVisual'

vi.mock('@google/model-viewer', () => ({}))

const webGLRenderingContext = Object.getOwnPropertyDescriptor(window, 'WebGLRenderingContext')
const webGL2RenderingContext = Object.getOwnPropertyDescriptor(window, 'WebGL2RenderingContext')

function restoreWebGLProperty(name: 'WebGLRenderingContext' | 'WebGL2RenderingContext', descriptor?: PropertyDescriptor) {
  if (descriptor) Object.defineProperty(window, name, descriptor)
  else delete (window as Window & Record<string, unknown>)[name]
}

describe('IdleVehicleVisual', () => {
  beforeEach(() => {
    class TestModelViewer extends HTMLElement {}
    if (!window.customElements.get('model-viewer')) window.customElements.define('model-viewer', TestModelViewer)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    restoreWebGLProperty('WebGLRenderingContext', webGLRenderingContext)
    restoreWebGLProperty('WebGL2RenderingContext', webGL2RenderingContext)
  })

  it('loads the locally hosted model viewer with accessible drag and rotation controls', async () => {
    Object.defineProperty(window, 'WebGLRenderingContext', { configurable: true, value: class WebGLRenderingContext {} })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as WebGLRenderingContext)

    render(<IdleVehicleVisual />)

    const model = await screen.findByTestId('idle-vehicle-model')
    expect(model).toHaveAttribute('src', '/car/idle-ev-concept.glb')
    expect(model).toHaveAttribute('alt', '深银色纯电概念车的可交互三维模型')
    expect(model).toHaveAttribute('aria-label', '深银色纯电概念车三维模型，可拖动旋转查看')
    expect(model).toHaveAttribute('camera-controls')
    expect(model).toHaveAttribute('auto-rotate')
    expect(model).toHaveAttribute('auto-rotate-delay', '1200')
    expect(model).toHaveAttribute('rotation-per-second', '18deg')
    expect(model).toHaveAttribute('touch-action', 'pan-y')

    fireEvent(model, new Event('error'))
    await waitFor(() => expect(screen.getByTestId('idle-vehicle-fallback')).toHaveAttribute('src', '/car/idle-car-ev.png'))
  })

  it('keeps the local PNG when WebGL is unavailable', async () => {
    Object.defineProperty(window, 'WebGLRenderingContext', { configurable: true, value: undefined })
    Object.defineProperty(window, 'WebGL2RenderingContext', { configurable: true, value: undefined })

    render(<IdleVehicleVisual />)

    await waitFor(() => expect(screen.getByTestId('idle-vehicle-fallback')).toHaveAttribute('src', '/car/idle-car-ev.png'))
    expect(screen.queryByTestId('idle-vehicle-model')).not.toBeInTheDocument()
  })
})
