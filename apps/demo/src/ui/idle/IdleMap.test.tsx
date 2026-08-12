import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IdleMap } from './IdleMap'
import { amapLoaderSnapshot, invalidateAMap, loadAMap } from '../amap/loader'
import { renderAMapPosition } from '../amap/render'

vi.mock('../amap/loader', () => ({
  amapLoaderSnapshot: vi.fn(),
  invalidateAMap: vi.fn(),
  loadAMap: vi.fn(),
  subscribeAMapLoader: vi.fn(() => () => {}),
}))

vi.mock('../amap/render', () => ({
  renderAMapPosition: vi.fn(),
}))

describe('IdleMap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(amapLoaderSnapshot).mockReturnValue({ state: 'ready', keyIndex: 0, keyCount: 2 })
  })

  it('rotates and reloads after the first key fails during Map initialization', async () => {
    const firstAMap = { key: 1 }
    const secondAMap = { key: 2 }
    const handle = { destroy: vi.fn() }
    vi.mocked(loadAMap)
      .mockResolvedValueOnce(firstAMap as never)
      .mockResolvedValueOnce(secondAMap as never)
    vi.mocked(renderAMapPosition)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(handle)

    render(<IdleMap />)

    await waitFor(() => expect(screen.getByLabelText('人民广场模拟车辆位置')).toHaveAttribute('data-map-source', 'amap'))
    expect(invalidateAMap).toHaveBeenCalledWith({ rotate: true })
    expect(loadAMap).toHaveBeenCalledTimes(2)
    expect(renderAMapPosition).toHaveBeenNthCalledWith(2, secondAMap, expect.any(HTMLElement), expect.objectContaining({ theme: 'dark' }))
  })
})
