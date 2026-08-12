import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CockpitWorkspace } from './CockpitWorkspace'

describe('CockpitWorkspace', () => {
  it('renders stable labeled slots for the persistent cockpit layers', () => {
    render(<CockpitWorkspace map={<div data-testid="map-instance">map</div>} mode="primary" phase="choosing-flight" />)
    expect(screen.getByTestId('cockpit-workspace')).toHaveAttribute('data-cockpit-workspace')
    expect(screen.getByTestId('cockpit-workspace')).toHaveAttribute('data-cockpit-mode', 'primary')
    expect(screen.getByLabelText('座舱地图')).toBeInTheDocument()
    expect(screen.getByLabelText('座舱状态')).toBeInTheDocument()
    expect(screen.getByLabelText('Agent反馈')).toBeInTheDocument()
    expect(screen.getByLabelText('主任务窗口')).toBeInTheDocument()
    expect(screen.getByLabelText('导航信息')).toBeInTheDocument()
    expect(screen.getByLabelText('辅助信息窗口')).toBeInTheDocument()
    expect(screen.getByLabelText('文字和语音入口')).toBeInTheDocument()
  })

  it('keeps the workspace and map node mounted while slot content changes', () => {
    const map = <div data-testid="map-instance">map</div>
    const rendered = render(<CockpitWorkspace map={map} mode="idle" />)
    const workspace = screen.getByTestId('cockpit-workspace')
    const mapInstance = screen.getByTestId('map-instance')
    rendered.rerender(<CockpitWorkspace map={map} mode="navigation" phase="driving-to-airport" primary={<div>hud content</div>} />)
    expect(screen.getByTestId('cockpit-workspace')).toBe(workspace)
    expect(screen.getByTestId('map-instance')).toBe(mapInstance)
    expect(screen.getByText('hud content')).toBeInTheDocument()
  })
})
