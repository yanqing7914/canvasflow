import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CockpitStatusBar } from './CockpitStatusBar'

describe('CockpitStatusBar', () => {
  it('shows brand, assistant status, phase and compact battery without a task', () => {
    render(<CockpitStatusBar
      vehicle={{ speedKph: 0, batteryPercent: 72, remainingRangeKm: 302, gear: 'P', isNight: false }}
    />)

    expect(screen.getByText('pilotflow')).toBeInTheDocument()
    expect(screen.getByText('小南待命')).toBeInTheDocument()
    expect(screen.getByText('空闲')).toBeInTheDocument()
    expect(screen.getByText('72%')).toBeInTheDocument()
    // The full clock/date/range facts are owned by the living and vehicle cards.
    expect(screen.queryByText('09:08')).not.toBeInTheDocument()
    expect(screen.queryByText(/8月12日/)).not.toBeInTheDocument()
    expect(screen.queryByText('302 km')).not.toBeInTheDocument()
    expect(screen.queryByText('时间')).not.toBeInTheDocument()
    expect(screen.queryByText('日期')).not.toBeInTheDocument()
    expect(screen.queryByText('续航')).not.toBeInTheDocument()
  })

  it('accepts an explicit assistant status and task phase label', () => {
    render(<CockpitStatusBar
      vehicle={{ speedKph: 0, batteryPercent: 55, remainingRangeKm: 200, gear: 'P', isNight: false }}
      phaseLabel="前往机场"
      assistantStatus="聆听中"
    />)
    expect(screen.getByText('小南聆听中')).toBeInTheDocument()
    expect(screen.getByText('前往机场')).toBeInTheDocument()
    expect(screen.getByText('55%')).toBeInTheDocument()
  })

  it('never exposes debug or API information', () => {
    render(<CockpitStatusBar
      vehicle={{ speedKph: 0, batteryPercent: 72, remainingRangeKm: 302, gear: 'P', isNight: false }}
      phaseLabel="前往机场"
    />)
    expect(screen.queryByText(/api.?key/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/taskId|revision|effects/i)).not.toBeInTheDocument()
  })
})
