import { createRef } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CockpitToolWindow, type CockpitToolWindowHandle } from './CockpitToolWindow'

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
}

describe('CockpitToolWindow', () => {
  beforeAll(() => vi.stubGlobal('PointerEvent', MouseEvent))
  afterAll(() => vi.unstubAllGlobals())
  afterEach(() => setViewport(1024, 768))

  it('stays mounted but hidden until opened, then focuses the dialog', () => {
    const rendered = render(
      <CockpitToolWindow open={false} title="演示控制" onClose={vi.fn()}>
        <button type="button">面板内容</button>
      </CockpitToolWindow>,
    )

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    rendered.rerender(
      <CockpitToolWindow open title="演示控制" onClose={vi.fn()}>
        <button type="button">面板内容</button>
      </CockpitToolWindow>,
    )

    expect(screen.getByRole('dialog', { name: '演示控制' })).toHaveFocus()
    expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-modal')
  })

  it('does not intercept pointer events while closed', () => {
    render(
      <CockpitToolWindow open={false} title="演示控制" onClose={vi.fn()}>
        <button type="button">面板内容</button>
      </CockpitToolWindow>,
    )

    const dialog = document.getElementById('demo-controls-tool-window')
    expect(dialog).toHaveAttribute('hidden')
    expect(dialog).toHaveStyle({ display: 'none' })
  })

  it('minimizes, restores through the handle, and preserves mode after closing and reopening', async () => {
    const user = userEvent.setup()
    const handle = createRef<CockpitToolWindowHandle>()
    const rendered = render(
      <CockpitToolWindow ref={handle} open title="演示控制" onClose={vi.fn()}>
        <p>面板内容</p>
      </CockpitToolWindow>,
    )

    await user.click(screen.getByRole('button', { name: '最小化演示控制窗口' }))
    expect(screen.getByRole('dialog')).toHaveAttribute('data-mode', 'minimized')
    expect(screen.queryByText('面板内容')).not.toBeInTheDocument()

    act(() => handle.current?.focusOrRestore())
    expect(screen.getByRole('dialog')).toHaveAttribute('data-mode', 'normal')
    expect(screen.getByRole('dialog')).toHaveFocus()

    await user.click(screen.getByRole('button', { name: '最小化演示控制窗口' }))
    rendered.rerender(
      <CockpitToolWindow ref={handle} open={false} title="演示控制" onClose={vi.fn()}>
        <p>面板内容</p>
      </CockpitToolWindow>,
    )
    rendered.rerender(
      <CockpitToolWindow ref={handle} open title="演示控制" onClose={vi.fn()}>
        <p>面板内容</p>
      </CockpitToolWindow>,
    )
    expect(screen.getByRole('dialog')).toHaveAttribute('data-mode', 'minimized')
  })

  it('closes from the control or Escape and restores focus to the opener', async () => {
    const user = userEvent.setup()
    const opener = document.createElement('button')
    opener.textContent = '打开'
    document.body.append(opener)
    opener.focus()
    const onClose = vi.fn()
    const rendered = render(
      <CockpitToolWindow open title="演示控制" onClose={onClose}>
        <button type="button">面板内容</button>
      </CockpitToolWindow>,
    )

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
    rendered.rerender(
      <CockpitToolWindow open={false} title="演示控制" onClose={onClose}>
        <button type="button">面板内容</button>
      </CockpitToolWindow>,
    )
    expect(opener).toHaveFocus()

    opener.focus()
    rendered.rerender(
      <CockpitToolWindow open title="演示控制" onClose={onClose}>
        <button type="button">面板内容</button>
      </CockpitToolWindow>,
    )
    await user.click(screen.getByRole('button', { name: '关闭演示控制窗口' }))
    expect(onClose).toHaveBeenCalledTimes(2)
    opener.remove()
  })

  it('constrains dragging to the viewport and re-constrains the saved position on resize', () => {
    setViewport(1000, 700)
    render(
      <CockpitToolWindow open title="演示控制" onClose={vi.fn()}>
        <p>面板内容</p>
      </CockpitToolWindow>,
    )
    const dialog = screen.getByRole('dialog')
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({
      width: 430, height: 500, x: 546, y: 72, left: 546, top: 72, right: 976, bottom: 572,
      toJSON: () => ({}),
    })
    const titlebar = screen.getByTestId('cockpit-tool-window-titlebar')

    fireEvent.pointerDown(titlebar, { button: 0, clientX: 600, clientY: 80, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 1600, clientY: 1000, pointerId: 1 })
    fireEvent.pointerUp(window, { pointerId: 1 })
    expect(dialog).toHaveStyle({ '--tool-window-x': '558px', '--tool-window-y': '188px' })

    setViewport(760, 540)
    fireEvent(window, new Event('resize'))
    expect(dialog).toHaveStyle({ '--tool-window-x': '318px', '--tool-window-y': '28px' })
  })

  it('does not start desktop dragging at the narrow-screen breakpoint', () => {
    setViewport(720, 800)
    render(
      <CockpitToolWindow open title="演示控制" onClose={vi.fn()}>
        <p>面板内容</p>
      </CockpitToolWindow>,
    )
    const dialog = screen.getByRole('dialog')
    const before = dialog.getAttribute('style')
    fireEvent.pointerDown(screen.getByTestId('cockpit-tool-window-titlebar'), { button: 0, clientX: 300, clientY: 40 })
    fireEvent.pointerMove(window, { clientX: 20, clientY: 500 })
    expect(dialog.getAttribute('style')).toBe(before)
  })

  it('re-constrains a saved desktop position when reopening after a hidden resize', () => {
    setViewport(1000, 700)
    const rendered = render(
      <CockpitToolWindow open title="演示控制" onClose={vi.fn()}>
        <p>面板内容</p>
      </CockpitToolWindow>,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveStyle({ '--tool-window-x': '546px' })

    rendered.rerender(
      <CockpitToolWindow open={false} title="演示控制" onClose={vi.fn()}>
        <p>面板内容</p>
      </CockpitToolWindow>,
    )
    setViewport(760, 540)
    fireEvent(window, new Event('resize'))
    rendered.rerender(
      <CockpitToolWindow open title="演示控制" onClose={vi.fn()}>
        <p>面板内容</p>
      </CockpitToolWindow>,
    )

    expect(dialog).toHaveStyle({ '--tool-window-x': '318px' })
  })

  it('re-constrains a minimized window before restoring its normal content height', async () => {
    const user = userEvent.setup()
    setViewport(1000, 700)
    render(
      <CockpitToolWindow open title="演示控制" onClose={vi.fn()}>
        <p>面板内容</p>
      </CockpitToolWindow>,
    )
    const dialog = screen.getByRole('dialog')
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({
      width: 320, height: 58, x: 656, y: 72, left: 656, top: 72, right: 976, bottom: 130,
      toJSON: () => ({}),
    })

    await user.click(screen.getByRole('button', { name: '最小化演示控制窗口' }))
    const titlebar = screen.getByTestId('cockpit-tool-window-titlebar')
    fireEvent.pointerDown(titlebar, { button: 0, clientX: 700, clientY: 80 })
    fireEvent.pointerMove(window, { clientX: 700, clientY: 1000 })
    fireEvent.pointerUp(window)
    expect(dialog).toHaveStyle({ '--tool-window-y': '630px' })

    await user.click(screen.getByRole('button', { name: '恢复演示控制窗口' }))
    expect(dialog).toHaveStyle({ '--tool-window-y': '368px' })
  })
})
