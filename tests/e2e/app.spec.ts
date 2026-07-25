import { expect, test, type Page } from '@playwright/test'

async function advanceFlow(page: Page) {
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && /\/v1\/tasks\/[^/]+\/(events|actions)$/.test(new URL(response.url()).pathname)
  ))
  await page.getByRole('button', { name: '推进下一事件' }).click()
  const response = await responsePromise
  expect(response.ok()).toBe(true)
  return response.json()
}

test('completes the airport pickup flow through the Agent API', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: '机场接人任务卡片' })).toBeVisible()
  const console = page.getByRole('region', { name: 'Event console' })
  const advance = page.getByRole('button', { name: '推进下一事件' })
  await expect(advance).toBeDisabled()
  await expect(console).toContainText('尚无任务')

  await page.getByRole('button', { name: '发送' }).click()
  await expect(console).toContainText('collecting-information')
  await expect(advance).toBeEnabled()

  await page.getByLabel('任务输入').fill('MU5102')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(console).toContainText('preparing')
  await page.getByRole('button', { name: '开始导航' }).click()

  await expect(console).toContainText('driving-to-airport')
  await expect(page.getByLabel('Effect receipts')).toContainText('navigation.start:succeeded')

  await advanceFlow(page) // charging.started
  await expect(console).toContainText('driving-to-airport')
  const inAir = await advanceFlow(page)
  expect(inAir.task.flight.status).toBe('in-air')
  await advanceFlow(page) // charging.completed
  await expect(page.getByText(/补能完成/)).toBeVisible()
  await advanceFlow(page) // flight landed
  await expect(console).toContainText('落地通知')
  await advanceFlow(page) // message.sent
  await expect(page.getByLabel('Effect receipts')).toContainText('message.send:succeeded')
  await advanceFlow(page) // airport geofence
  await expect(console).toContainText('approaching-airport')
  await advanceFlow(page) // parked
  await expect(console).toContainText('waiting-for-passengers')
  await advanceFlow(page) // passengers onboard
  await expect(console).toContainText('returning-home')
  await expect(page.getByLabel('Effect receipts')).toContainText('navigation.update-route:succeeded')
  await expect(page.getByLabel('Effect receipts')).toContainText('vehicle.apply-cabin-profile:succeeded')
  await expect(page.getByLabel('Effect receipts')).toContainText('media.play:succeeded')
  await advanceFlow(page) // cabin preference input
  await advanceFlow(page) // destination.arrived
  await expect(console).toContainText('completed')
  await expect(page.getByLabel('Effect receipts')).toContainText('memory.propose-update:pending-confirmation')

  await page.getByRole('button', { name: '保存本次偏好' }).click()
  await expect(page.getByLabel('Effect receipts')).toContainText('memory.confirm-update:succeeded')
  await expect(page.getByRole('button', { name: '保存本次偏好' })).toHaveCount(0)
})

test('rejects the arrival memory proposal through the confirmation API', async ({ page }) => {
  await page.goto('/')
  const console = page.getByRole('region', { name: 'Event console' })

  await page.getByRole('button', { name: '发送' }).click()
  await page.getByLabel('任务输入').fill('MU5102')
  await page.getByRole('button', { name: '发送' }).click()
  await page.getByRole('button', { name: '开始导航' }).click()

  for (let step = 0; step < 10; step += 1) await advanceFlow(page)
  await expect(console).toContainText('completed')
  await page.getByRole('button', { name: '暂不保存' }).click()

  await expect(page.getByLabel('Effect receipts')).toContainText('memory.reject-update:cancelled')
  await expect(page.getByRole('button', { name: '暂不保存' })).toHaveCount(0)
})
