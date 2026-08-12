import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { IdleCockpit } from './IdleCockpit'

vi.mock('./IdleMap', () => ({
  IdleMap: () => (
    <div aria-label="人民广场模拟车辆位置" data-map-source="unavailable">
      模拟位置，非真实 GPS
    </div>
  ),
}))

describe('IdleCockpit', () => {
  it('shows Shanghai time, five quiet cabin facts, and a stationary simulated map', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-12T01:08:00.000Z'))
      render(<IdleCockpit
        vehicle={{ speedKph: 0, batteryPercent: 42, remainingRangeKm: 112, gear: 'P', isNight: false }}
        voiceMode="needs-authorization"
        voiceStatus=""
        onMicrophone={() => {}}
        onKeyboard={() => {}}
        onControls={() => {}}
      />)
      const facts = screen.getByLabelText('空闲座舱状态')
      expect(facts.querySelectorAll('dt')).toHaveLength(5)
      expect(screen.getByText('09:08')).toBeInTheDocument()
      expect(screen.getByText('8月12日周三')).toBeInTheDocument()
      expect(screen.getByText('42%')).toBeInTheDocument()
      expect(screen.getByText('112 km')).toBeInTheDocument()
      expect(screen.getByLabelText('人民广场模拟车辆位置')).toHaveTextContent('模拟位置，非真实 GPS')
      expect(facts).not.toHaveTextContent('航班')
      expect(screen.queryByText(/模拟行程进度/)).not.toBeInTheDocument()
      expect(screen.getByLabelText('人民广场模拟车辆位置')).toHaveAttribute('data-map-source', 'unavailable')
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers an enabled retry action after voice recognition is interrupted', () => {
    const onMicrophone = vi.fn()
    render(<IdleCockpit
      vehicle={{ speedKph: 0, batteryPercent: 42, remainingRangeKm: 112, gear: 'P', isNight: false }}
      voiceMode="needs-authorization"
      voiceStatus="语音监听已中断"
      voiceRetryable
      onMicrophone={onMicrophone}
      onKeyboard={() => {}}
      onControls={() => {}}
    />)

    const retry = screen.getByRole('button', { name: '重试语音唤醒' })
    expect(retry).toBeEnabled()
    expect(retry).toHaveTextContent('重试语音')
    expect(screen.getByRole('status')).toHaveTextContent('语音监听已中断')
    fireEvent.click(retry)
    expect(onMicrophone).toHaveBeenCalledOnce()
  })
})
