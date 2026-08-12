import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CockpitStatusBar } from './CockpitStatusBar'

describe('CockpitStatusBar', () => {
  it('shows the fixed cockpit facts without inventing a task', () => {
    render(<CockpitStatusBar
      now={() => new Date('2026-08-12T09:08:00+08:00')}
      vehicle={{ speedKph: 0, batteryPercent: 72, remainingRangeKm: 302, gear: 'P', isNight: false }}
    />)

    expect(screen.getByText('09:08')).toBeInTheDocument()
    expect(screen.getByText(/8月12日/)).toBeInTheDocument()
    expect(screen.getByText('72%')).toBeInTheDocument()
    expect(screen.getByText('302 km')).toBeInTheDocument()
    expect(screen.getByText('小南待命')).toBeInTheDocument()
    expect(screen.queryByText('等待创建任务')).not.toBeInTheDocument()
  })
})
