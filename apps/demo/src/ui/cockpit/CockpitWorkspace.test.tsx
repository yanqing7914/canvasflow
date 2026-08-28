import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CockpitWorkspace } from './CockpitWorkspace'

describe('CockpitWorkspace', () => {
  it('renders stable labeled slots for the persistent cockpit layers', () => {
    render(<CockpitWorkspace map={<div data-testid="map-instance">map</div>} mode="primary" phase="choosing-flight" />)
    expect(screen.getByTestId('cockpit-workspace')).toHaveAttribute('data-cockpit-workspace')
    expect(screen.getByTestId('cockpit-workspace')).toHaveAttribute('data-cockpit-mode', 'primary')
    expect(screen.getByLabelText('座舱地图')).toBeInTheDocument()
    expect(screen.queryByLabelText('座舱状态')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Agent反馈')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('主任务窗口')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('导航层')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('辅助信息窗口')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('文字和语音入口')).not.toBeInTheDocument()
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
