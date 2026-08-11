import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { IdleCockpit } from './IdleCockpit'

describe('IdleCockpit', () => {
  it('shows only the five quiet cabin facts and a stationary simulated map', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-12T09:08:00+08:00'))
    render(<IdleCockpit
      vehicle={{ speedKph: 0, batteryPercent: 42, remainingRangeKm: 112, gear: 'P', isNight: false }}
      voiceMode="needs-authorization"
      voiceStatus=""
      onMicrophone={() => {}}
      onKeyboard={() => {}}
      onControls={() => {}}
    />)
    const facts = screen.getByLabelText('空闲座舱状态')
    expect(screen.getByLabelText('空闲座舱状态').querySelectorAll('dt')).toHaveLength(5)
    expect(screen.getByText('09:08')).toBeInTheDocument()
    expect(screen.getByText('42%')).toBeInTheDocument()
    expect(screen.getByText('112 km')).toBeInTheDocument()
    expect(screen.getByLabelText('人民广场模拟车辆位置')).toHaveTextContent('模拟位置，非真实 GPS')
    expect(facts).not.toHaveTextContent('航班')
    expect(screen.queryByText(/模拟行程进度/)).not.toBeInTheDocument()
    vi.useRealTimers()
  })
})
