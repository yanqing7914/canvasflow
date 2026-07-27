import { expect, test, type Page } from '@playwright/test'

const apiRequest = {
  vehicleContext: { speedKph: 0, batteryPercent: 42, remainingRangeKm: 210, gear: 'P', isNight: true },
  clientCapabilities: { uiSchemaVersion: '1.0', supportsSse: true, supportsTts: true },
}

function futureTimestamp(offsetMinutes = 0) {
  return new Date(Date.now() + 24 * 60 * 60 * 1_000 + offsetMinutes * 60 * 1_000).toISOString()
}

async function postApi(page: Page, path: string, body: unknown) {
  return page.context().request.post(path, {
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    data: body,
  })
}

async function advanceFlow(page: Page) {
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && /\/v1\/tasks\/[^/]+\/(events|actions)$/.test(new URL(response.url()).pathname)
  ))
  await page.getByRole('button', { name: '推进下一事件' }).click()
  const response = await responsePromise
  expect(response.ok()).toBe(true)
  const result = await response.json()
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
  return result
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
    const taskInput = page.getByLabel('任务输入')
    const submit = page.getByRole('button', { name: '发送' })
    await page.keyboard.press('Tab')
    await expect(taskInput).toBeFocused()
    await page.keyboard.press('Enter')

    const surface = page.getByRole('region', { name: 'Generated task interface' })
    await expect(surface).toBeVisible()
    await expect(surface).toHaveAttribute('data-layout', 'stack')
    await expect(surface.locator('[data-component-type="status-banner"]')).toBeVisible()
    await taskInput.fill('MU5102')
    await page.keyboard.press('Tab')
    await expect(submit).toBeFocused()
    await page.keyboard.press('Enter')
    const startNavigation = page.getByRole('button', { name: '开始导航' })
    const advance = page.getByRole('button', { name: '推进下一事件' })
    await expect(startNavigation).toBeEnabled()
    await submit.focus()
    await page.keyboard.press('Tab')
    await expect(advance).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(startNavigation).toBeFocused()
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

test('applies an out-of-band task update through the durable SSE stream', async ({ page }) => {
  await page.goto('/')
  const createResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/v1/tasks'
  ))
  await page.getByRole('button', { name: '发送' }).click()
  const created = await (await createResponsePromise).json()

  const preparedResponse = await postApi(page, `/v1/tasks/${created.task.taskId}/events`, {
    clientRequestId: 'e2e-sse-flight-request',
    expectedTaskRevision: created.task.taskRevision,
    event: {
      eventId: 'e2e-sse-flight',
      type: 'user.input',
      text: 'MU5102',
      timestamp: futureTimestamp(),
    },
  })
  expect(preparedResponse.ok()).toBe(true)
  const prepared = await preparedResponse.json()

  const started = await postApi(page, `/v1/tasks/${created.task.taskId}/actions`, {
    clientRequestId: 'e2e-sse-start-request',
    expectedTaskRevision: prepared.task.taskRevision,
    expectedUiRevision: prepared.ui.uiRevision,
    actionId: 'start-navigation',
    componentId: 'navigation-plan',
    idempotencyKey: 'e2e-sse-start',
  })
  expect(started.ok()).toBe(true)
  await expect(page.getByRole('region', { name: 'Event console' })).toContainText('driving-to-airport')
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
    if (request.method() !== 'POST') {
      await route.continue()
      return
    }
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

test('replays a duplicate event without applying it twice', async ({ page }) => {
  await page.goto('/')
  const createdResponse = await postApi(page, '/v1/tasks', {
    clientRequestId: 'e2e-duplicate-create',
    input: { type: 'text', text: '接妈妈' },
    ...apiRequest,
  })
  expect(createdResponse.status()).toBe(201)
  const created = await createdResponse.json()

  const event = {
    clientRequestId: 'e2e-duplicate-event-first',
    expectedTaskRevision: created.task.taskRevision,
    event: {
      eventId: 'e2e-duplicate-flight',
      type: 'user.input',
      text: 'MU5102',
      timestamp: futureTimestamp(1),
    },
  }
  const firstResponse = await postApi(page, `/v1/tasks/${created.task.taskId}/events`, event)
  expect(firstResponse.status()).toBe(200)
  const first = await firstResponse.json()

  const replayResponse = await postApi(page, `/v1/tasks/${created.task.taskId}/events`, {
    ...event,
    clientRequestId: 'e2e-duplicate-event-replay',
  })
  expect(replayResponse.status()).toBe(200)
  await expect(replayResponse.json()).resolves.toMatchObject({
    task: first.task,
    ui: first.ui,
    effects: first.effects,
  })
})

test('cancels a flight before navigation and rejects the navigation action', async ({ page }) => {
  await page.goto('/')
  const createdResponse = await postApi(page, '/v1/tasks', {
    clientRequestId: 'e2e-flight-cancel-create',
    input: { type: 'text', text: '接妈妈，航班 MU5102' },
    ...apiRequest,
  })
  expect(createdResponse.status()).toBe(201)
  const created = await createdResponse.json()
  expect(created.task.phase).toBe('preparing')

  const cancelledResponse = await postApi(page, `/v1/tasks/${created.task.taskId}/events`, {
    clientRequestId: 'e2e-flight-cancel-event',
    expectedTaskRevision: created.task.taskRevision,
    event: {
      eventId: 'e2e-flight-cancelled',
      type: 'flight.updated',
      flight: {
        flightNumber: 'MU5102',
        status: 'cancelled',
        scheduledArrival: '2026-07-22T20:30:00+08:00',
        estimatedArrival: '2026-07-22T20:30:00+08:00',
        terminal: 'T2',
      },
      timestamp: futureTimestamp(2),
    },
  })
  expect(cancelledResponse.status()).toBe(200)
  const cancelled = await cancelledResponse.json()
  expect(cancelled.task).toMatchObject({ phase: 'preparing', flight: { status: 'cancelled' } })
  expect(cancelled.ui.actions).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'start-navigation' })]))

  const navigationResponse = await postApi(page, `/v1/tasks/${created.task.taskId}/actions`, {
    clientRequestId: 'e2e-flight-cancel-navigation',
    expectedTaskRevision: cancelled.task.taskRevision,
    expectedUiRevision: cancelled.ui.uiRevision,
    actionId: 'start-navigation',
    componentId: 'navigation-plan',
    idempotencyKey: 'e2e-flight-cancel-navigation',
  })
  expect(navigationResponse.status()).toBe(400)
  await expect(navigationResponse.json()).resolves.toMatchObject({
    error: { code: 'INVALID_REQUEST' },
    latest: { task: { flight: { status: 'cancelled' } } },
  })
})

test('shows a deterministic fallback when the flight provider times out', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('任务输入').fill('接妈妈，航班 MU0000')
  await page.getByRole('button', { name: '发送' }).click()

  await expect(page.getByRole('region', { name: 'Generated task interface' })).toContainText('数据暂时不可用')
  await expect(page.getByRole('region', { name: 'Generated task interface' })).toContainText('请稍后重试')
  await expect(page.getByLabel('Event console')).toContainText('preparing')
})

test('returns CONFIRMATION_EXPIRED when a resolved memory confirmation is reused', async ({ page }) => {
  await page.goto('/')
  const createdResponse = await postApi(page, '/v1/tasks', {
    clientRequestId: 'e2e-confirmation-create',
    input: { type: 'text', text: '接妈妈，航班 MU5102' },
    ...apiRequest,
  })
  expect(createdResponse.status()).toBe(201)
  let current = await createdResponse.json()

  const actionResponse = await postApi(page, `/v1/tasks/${current.task.taskId}/actions`, {
    clientRequestId: 'e2e-confirmation-start',
    expectedTaskRevision: current.task.taskRevision,
    expectedUiRevision: current.ui.uiRevision,
    actionId: 'start-navigation',
    componentId: 'navigation-plan',
    idempotencyKey: 'e2e-confirmation-start',
  })
  expect(actionResponse.status()).toBe(200)
  current = await actionResponse.json()

  const events = [
    { type: 'charging.started', stationId: 'station-hongqiao-01' },
    { type: 'flight.updated', flight: { flightNumber: 'MU5102', status: 'in-air', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' } },
    { type: 'charging.completed', batteryPercent: 78 },
    { type: 'flight.updated', flight: { flightNumber: 'MU5102', status: 'landed', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2', baggageClaim: '12' } },
    { type: 'message.sent', messageId: 'MU5102:landing' },
    { type: 'vehicle.entered-airport-geofence' },
    { type: 'vehicle.parked' },
    { type: 'user.confirmed-passengers-onboard' },
    { type: 'user.input', text: '应用家庭座舱偏好' },
    { type: 'destination.arrived', destination: '家' },
  ] as const
  for (const [index, event] of events.entries()) {
    const eventResponse = await postApi(page, `/v1/tasks/${current.task.taskId}/events`, {
      clientRequestId: `e2e-confirmation-event-${index}`,
      expectedTaskRevision: current.task.taskRevision,
      event: { ...event, eventId: `e2e-confirmation-event-${index}`, timestamp: futureTimestamp(index + 3) },
    })
    expect(eventResponse.status()).toBe(200)
    current = await eventResponse.json()
  }
  const completed = current
  expect(completed?.task.phase).toBe('completed')
  const confirmationId = completed.task.pendingConfirmation.confirmationId

  const acceptResponse = await postApi(page, `/v1/tasks/${completed.task.taskId}/confirmations/${confirmationId}`, {
    clientRequestId: 'e2e-confirmation-accept',
    expectedTaskRevision: completed.task.taskRevision,
    decision: 'accept',
    idempotencyKey: 'e2e-confirmation-accept',
  })
  expect(acceptResponse.status()).toBe(200)
  const accepted = await acceptResponse.json()

  const replayResponse = await postApi(page, `/v1/tasks/${completed.task.taskId}/confirmations/${confirmationId}`, {
    clientRequestId: 'e2e-expired-confirmation-replay',
    expectedTaskRevision: accepted.task.taskRevision,
    decision: 'accept',
    idempotencyKey: 'e2e-expired-confirmation-replay',
  })
  expect(replayResponse.status()).toBe(410)
  await expect(replayResponse.json()).resolves.toMatchObject({ error: { code: 'CONFIRMATION_EXPIRED' } })
})
