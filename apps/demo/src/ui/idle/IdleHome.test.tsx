import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { VehicleContext } from '@canvasflow/schema'
import { IdleHome } from './IdleHome'

const vehicle: VehicleContext = { speedKph: 0, batteryPercent: 42, remainingRangeKm: 112, gear: 'P', isNight: false }

describe('IdleHome', () => {
  it('shows the three simulated home capabilities from vehicle context only once', () => {
    render(<IdleHome vehicle={vehicle} voiceStatus="等待唤醒" onWeather={() => {}} onSchedule={() => {}} onVehicleStatus={() => {}} onSpeedDown={() => {}} onSpeedUp={() => {}} />)
    expect(screen.getByRole('region', { name: '空闲座舱首页' })).toBeInTheDocument()
    expect(screen.getByText('多云')).toBeInTheDocument()
    expect(screen.getByText('Her 开发日会')).toBeInTheDocument()
    expect(screen.getByText('新建 Her')).toBeInTheDocument()
    expect(screen.getByText('A2A 调研')).toBeInTheDocument()
    expect(screen.getByText('42%')).toBeInTheDocument()
    expect(screen.getByText('112 km')).toBeInTheDocument()
    expect(screen.getByText('P')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '调快' })).toBeDisabled()
    expect(screen.queryByText('天气接口')).not.toBeInTheDocument()
  })

  it('delegates each capability instead of changing vehicle facts locally', async () => {
    const user = userEvent.setup()
    const weather = vi.fn(), calendar = vi.fn(), vehicleStatus = vi.fn()
    render(<IdleHome vehicle={{ ...vehicle, speedKph: 55, gear: 'D' }} voiceStatus="等待唤醒" onWeather={weather} onSchedule={calendar} onVehicleStatus={vehicleStatus} onSpeedDown={() => {}} onSpeedUp={() => {}} />)
    await user.click(screen.getByRole('button', { name: '查看天气' }))
    await user.click(screen.getByRole('button', { name: '查看日程' }))
    await user.click(screen.getByRole('button', { name: '查看车辆状态' }))
    expect(weather).toHaveBeenCalledOnce()
    expect(calendar).toHaveBeenCalledOnce()
    expect(vehicleStatus).toHaveBeenCalledOnce()
  })
})
