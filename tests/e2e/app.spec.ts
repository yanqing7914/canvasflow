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

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    document: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }))
  expect(Math.max(dimensions.body, dimensions.document)).toBeLessThanOrEqual(dimensions.viewport)
}

test('renders the UISpec surface responsively and keeps primary controls keyboard accessible', async ({ page }) => {
  for (const viewport of [{ width: 375, height: 812 }, { width: 1920, height: 720 }]) {
    await page.setViewportSize(viewport)
    await page.goto('/')
    await page.getByLabel('任务输入').focus()
    await page.keyboard.press('Enter')

    const surface = page.getByRole('region', { name: 'Generated task interface' })
    await expect(surface).toBeVisible()
    await expect(surface).toHaveAttribute('data-layout', 'stack')
    await expect(surface.locator('[data-component-type="status-banner"]')).toBeVisible()
    await page.getByLabel('任务输入').fill('MU5102')
    await page.getByRole('button', { name: '发送' }).click()
    const startNavigation = page.getByRole('button', { name: '开始导航' })
    await expect(startNavigation).toBeEnabled()
    await startNavigation.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('region', { name: 'Event console' })).toContainText('driving-to-airport')
    await expectNoHorizontalOverflow(page)
  }
})

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

test('retries a failed landing message through action and confirmation APIs', async ({ page }) => {
  await page.route('**/v1/tasks/*/events', async (route) => {
    const request = route.request()
    const payload = request.postDataJSON() as {
      event?: {
        eventId?: string
        flight?: { flightNumber?: string }
        messageId?: string
        timestamp?: string
        type?: string
      }
    }
    if (payload.event?.type === 'message.sent' && payload.event.messageId === 'MU5102:landing') {
      await route.continue({
        postData: JSON.stringify({
          ...payload,
          event: { ...payload.event, messageId: 'MU5103:landing' },
        }),
      })
      return
    }
    if (payload.event?.type !== 'flight.updated' || payload.event.flight?.flightNumber !== 'MU5102') {
      await route.continue()
      return
    }

    await route.continue({
      postData: JSON.stringify({
        ...payload,
        event: {
          ...payload.event,
          flight: { ...payload.event.flight, flightNumber: 'MU5103' },
        },
      }),
    })
  })
  await page.goto('/')
  const console = page.getByRole('region', { name: 'Event console' })

  await page.getByRole('button', { name: '发送' }).click()
  await page.getByLabel('任务输入').fill('MU5102')
  await page.getByRole('button', { name: '发送' }).click()
  await page.getByRole('button', { name: '开始导航' }).click()
  await expect(console).toContainText('driving-to-airport')
  await advanceFlow(page) // charging.started
  await advanceFlow(page) // flight in-air
  await advanceFlow(page) // charging.completed
  await advanceFlow(page) // flight landed
  const failedSend = await advanceFlow(page) // message.send provider returns SEND_FAILED

  expect(failedSend).toMatchObject({
    task: { message: { status: 'failed', landingNoticeSent: false } },
    effects: [
      { type: 'message.send', status: 'failed', errorCode: 'SEND_FAILED' },
      { type: 'message.revoke-authorization', status: 'cancelled' },
    ],
  })
  await expect(console).toContainText('落地通知失败')
  await expect(page.getByRole('button', { name: '重试发送' })).toBeVisible()

  const prepareResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && /\/v1\/tasks\/[^/]+\/actions$/.test(new URL(response.url()).pathname)
    && (response.request().postDataJSON() as { actionId?: string }).actionId === 'retry-landing-message'
  ))
  await page.getByRole('button', { name: '重试发送' }).click()
  const prepareResponse = await prepareResponsePromise
  expect(prepareResponse.ok()).toBe(true)
  await expect(prepareResponse.json()).resolves.toMatchObject({
    effects: [{ type: 'message.prepare', status: 'pending-confirmation' }],
  })
  await expect(page.getByRole('button', { name: '确认发送' })).toBeVisible()

  const sendResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && /\/v1\/tasks\/[^/]+\/confirmations\//.test(new URL(response.url()).pathname)
    && (response.request().postDataJSON() as { decision?: string }).decision === 'accept'
  ))
  await page.getByRole('button', { name: '确认发送' }).click()
  const sendResponse = await sendResponsePromise
  expect(sendResponse.ok()).toBe(true)
  await expect(sendResponse.json()).resolves.toMatchObject({
    task: { message: { status: 'sent', landingNoticeSent: true } },
    effects: [{ type: 'message.send', status: 'succeeded' }],
  })
  await expect(page.getByLabel('Effect receipts')).toContainText('message.send:succeeded')
  await expect(page.getByRole('button', { name: '确认发送' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '重试发送' })).toHaveCount(0)
})
