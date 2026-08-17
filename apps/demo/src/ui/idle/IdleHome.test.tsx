import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { VehicleContext } from '@canvasflow/schema'
import { IdleHome } from './IdleHome'

const vehicle: VehicleContext = { speedKph: 0, batteryPercent: 42, remainingRangeKm: 112, gear: 'P', isNight: false }

describe('IdleHome', () => {
  it('shows the three simulated home capabilities from vehicle context only once', () => {
    render(<IdleHome vehicle={vehicle} onWeather={() => {}} onSchedule={() => {}} onVehicleStatus={() => {}} />)
    expect(screen.getByRole('region', { name: '空闲座舱' })).toBeInTheDocument()
    expect(screen.getByText('多云')).toBeInTheDocument()
    expect(screen.getByText('Her 开发日会')).toBeInTheDocument()
    expect(screen.getByText('新建 Her')).toBeInTheDocument()
    expect(screen.getByText('A2A 调研')).toBeInTheDocument()
    expect(screen.getByText('42%')).toBeInTheDocument()
    expect(screen.getByText('112 km')).toBeInTheDocument()
    expect(screen.getByText('P')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '当前时间' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '模拟天气' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '今日日程' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '查看天气' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: '查看日程' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: '调快' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '调慢' })).not.toBeInTheDocument()
    expect(screen.getByText('0 km/h')).toBeInTheDocument()
    expect(screen.getByText('驻车')).toBeInTheDocument()
    expect(screen.queryByText('天气接口')).not.toBeInTheDocument()
    expect(screen.getByText('模拟位置：人民广场 · 非真实 GPS')).toBeInTheDocument()
    expect(screen.queryByText(/小南\s*等待唤醒/)).not.toBeInTheDocument()
    const vehicleImage = screen.getByAltText('')
    expect(vehicleImage).toHaveAttribute('src', '/car/idle-car.png')
    expect(vehicleImage).toHaveAttribute('width', '2000')
    expect(vehicleImage).toHaveAttribute('height', '900')
  })

  it('delegates each capability instead of changing vehicle facts locally', async () => {
    const user = userEvent.setup()
    const weather = vi.fn(), calendar = vi.fn(), vehicleStatus = vi.fn()
    render(<IdleHome vehicle={{ ...vehicle, speedKph: 55, gear: 'D' }} onWeather={weather} onSchedule={calendar} onVehicleStatus={vehicleStatus} />)
    await user.click(screen.getByRole('button', { name: '查看天气' }))
    await user.click(screen.getByRole('button', { name: '查看日程' }))
    await user.click(screen.getByRole('button', { name: '查看车辆状态' }))
    expect(weather).toHaveBeenCalledOnce()
    expect(calendar).toHaveBeenCalledOnce()
    expect(vehicleStatus).toHaveBeenCalledOnce()
  })
})
