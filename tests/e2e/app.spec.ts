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

/**
 * Engineering metadata and the demo player live in a modal controls drawer, never on
 * the driver-facing brief. The drawer overlays the brief with a scrim, so it is opened
 * to read, then closed again before the next interaction with the trip surface.
 */
async function readControls(page: Page, expected: string | RegExp) {
  await page.getByRole('button', { name: '打开演示控制' }).click()
  const drawer = page.getByRole('dialog', { name: '演示控制' })
  await expect(drawer).toContainText(expected)
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
}

/**
 * The keyboard is on demand, not a permanent input row: in a browser with working
 * speech recognition it is not on screen until the turn needs it or the driver
 * asks for it, and it leaves again once a typed message has been sent. Every text
 * step therefore opens it first, waiting on the 文字 entry rather than on the
 * field — a field left over from the previous turn may still be tearing down, and
 * filling that one detaches mid-action.
 */
async function composer(page: Page) {
  if (await page.getByLabel('任务输入').count() === 0) {
    const toggle = page.getByRole('button', { name: '改用文字输入' })
    await expect(toggle).toBeEnabled()
    await toggle.click()
  }
  // Resolve and settle the field itself rather than the toggle: when voice is
  // unavailable the toggle is deliberately disabled forever, and a field left from
  // the previous turn may still be disabled by a request in flight.
  const input = page.getByLabel('任务输入')
  await expect(input).toBeEnabled()
  return input
}

/**
 * Types into the on-demand keyboard and sends, opening it if it is not open. Waits
 * for the send to settle: an accepted typed message closes the composer, so
 * returning early would leave the next step racing a field that is unmounting.
 */
async function sendText(page: Page, value?: string) {
  const input = await composer(page)
  if (value !== undefined) await input.fill(value)
  await page.getByRole('button', { name: '发送' }).click()
  // Either the composer left (the send was accepted and text was the only reason
  // it was open) or it is back to editable — never mid-flight.
  await expect(async () => {
    const field = page.getByLabel('任务输入')
    if (await field.count() === 0) return
    await expect(field).toBeEnabled()
  }).toPass({ timeout: 10_000 })
}

async function expectAdvanceEnabled(page: Page, enabled: boolean) {
  await page.getByRole('button', { name: '打开演示控制' }).click()
  const advance = page.getByRole('button', { name: /推进下一事件|行程已完成|行程已取消/ })
  if (enabled) await expect(advance).toBeEnabled()
  else await expect(advance).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: '演示控制' })).toBeHidden()
}

async function advanceFlow(page: Page) {
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && /\/v1\/tasks\/[^/]+\/(events|actions)$/.test(new URL(response.url()).pathname)
  ))
  await page.getByRole('button', { name: '打开演示控制' }).click()
  await page.getByRole('button', { name: /推进下一事件/ }).click()
  await page.keyboard.press('Escape')
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

/**
 * DESIGN.md forbids both scroll axes at the demo resolution, and the brief has to
 * genuinely fit rather than merely be unscrollable. `.demo-shell` sets
 * `overflow: hidden`, which clamps `document.scrollHeight` to the viewport: a brief
 * taller than the fold is silently clipped instead of scrollable, so asserting on
 * page scroll height alone can never fail. What is checkable is the four ways the
 * rule can actually break — a clipped scroll container, a box clipped across its
 * own width, a line of text ellipsized inside a box that itself fits, or the
 * brief's own box extending past the fold.
 *
 * The cards are measured alongside the containers because that is where clipping
 * actually lands: `.ui-card` hides its own overflow, so a card starved of height by
 * the stack's row allocation loses content while `.task-surface` and every other
 * container still report zero.
 *
 * Only asserted above the 680px breakpoint, where DESIGN.md deliberately allows a
 * phone-width brief to become a scrolling single-column flow.
 */
async function expectNoScroll(page: Page) {
  // The 1920x720 project selects its specs with `grep: /@layout/`, so a layout
  // assertion in an untagged spec runs only at 1280x720 and silently never at the
  // resolution the rule is written for. The tag is a hand-written convention with
  // nothing enforcing it, which makes forgetting it a coverage hole that looks
  // exactly like coverage — so an untagged caller fails here instead.
  expect(
    test.info().tags,
    'a spec asserting layout must be tagged @layout, or the chromium-1920x720 project skips it',
  ).toContain('@layout')
  await expectNoHorizontalOverflow(page)
  const layout = await page.evaluate(() => {
    const viewport = document.documentElement.clientHeight
    const measure = (selector: string) => [...document.querySelectorAll(selector)]
      .map((element, index) => {
        if (!(element instanceof HTMLElement)) return null
        return {
          selector: `${selector}[${index}]`,
          // Hidden overflow turns "too tall" into "clipped" rather than "scrollable".
          clippedBy: element.scrollHeight - element.clientHeight,
          // The same trap on the width axis: `.ui-card` hides its overflow, so a
          // card whose grid tracks demand more than its column loses content off
          // its right edge while the document's own scrollWidth stays clean and
          // `expectNoHorizontalOverflow` above sees nothing.
          clippedWidthBy: element.scrollWidth - element.clientWidth,
          // A box that ends below the fold is content the driver cannot reach at all.
          pastFoldBy: Math.round(element.getBoundingClientRect().bottom) - viewport,
        }
      })
      .filter((box): box is NonNullable<typeof box> => box !== null)
    return {
      width: document.documentElement.clientWidth,
      // The frame containers, and then the brief's own cards. `.ui-card` sets
      // `overflow: hidden`, so a card squeezed by its neighbours loses its content
      // mid-sentence while every container above it still measures as clean — the
      // outer boxes alone cannot see that failure.
      boxes: ['.demo-shell', '.cockpit-stage', '.task-surface', '.trip-brief__content', '.ui-slot', '.ui-component', '.ui-card']
        .flatMap(measure),
      // One level below the card, and on the width axis only. The metric label and
      // figure are `nowrap` with an ellipsis, so a card that fits its own column
      // can still hold a figure reading 到达电… — the truncation happens inside the
      // leaf, where the card's scrollWidth cannot see it.
      //
      // Height is deliberately not asserted on these: they set `line-height` equal
      // to `font-size`, so the line box is a couple of pixels shorter than the
      // font's natural ascent plus descent, and every one of them reports a
      // standing 2px `clippedBy` that has nothing to do with the layout fitting.
      textBoxes: ['.ui-metric__label', '.ui-metric__value'].flatMap(measure),
    }
  })
  if (layout.width <= 680) return
  expect(layout.boxes.length).toBeGreaterThan(0)
  // One assertion per axis of failure, reported with the measurements so a
  // regression says which box overflowed and by how much.
  expect(layout.boxes.filter((box) => box.clippedBy > 1)).toEqual([])
  expect(layout.boxes.filter((box) => box.clippedWidthBy > 1)).toEqual([])
  expect(layout.boxes.filter((box) => box.pastFoldBy > 1)).toEqual([])
  expect(layout.textBoxes.filter((box) => box.clippedWidthBy > 1)).toEqual([])
}

/**
 * Which way across the frame the drawn route runs.
 *
 * The standalone panel is projected as a map — north up, west left, deliberately
 * unmirrored, unlike the in-card band — so the sign of (last x − first x) on the
 * route line is the compass direction of the leg. It is the one thing about the
 * drawing that a mislabelled destination cannot fake, which is what makes it the
 * assertion for "the map followed the airport the driver picked".
 */
async function routeLineDirection(page: Page): Promise<'east' | 'west'> {
  const path = await page.locator('.ui-route-map__line').getAttribute('d')
  const xs = [...(path ?? '').matchAll(/[ML] (-?[\d.]+) (-?[\d.]+)/g)].map((match) => Number(match[1]))
  expect(xs.length, `expected a drawn route line, got ${path}`).toBeGreaterThan(1)
  return xs[xs.length - 1]! > xs[0]! ? 'east' : 'west'
}

test('renders the UISpec surface responsively and keeps primary controls keyboard accessible @layout', async ({ page }, testInfo) => {
  // The 1920x720 project supplies the demo resolution through its own viewport, so
  // resizing here would throw it away; the default project still sweeps both widths.
  const viewports = testInfo.project.name === 'chromium-1920x720'
    ? [null]
    : [{ width: 375, height: 812 }, { width: 1920, height: 720 }]
  for (const viewport of viewports) {
    if (viewport) await page.setViewportSize(viewport)
    await page.goto('/')
    const mic = page.getByRole('button', { name: /开始语音输入|语音入口暂不可用/ })
    const keyboard = page.getByRole('button', { name: '改用文字输入' })
    const controls = page.getByRole('button', { name: '打开演示控制' })
    // Wait for the mounted surface before pressing a key: a Tab that arrives
    // pre-hydration lands on nothing and is not replayed.
    await expect(controls).toBeVisible()

    // Tab order follows the brief's reading order: brand, then the header
    // utilities. The keyboard is not in it yet because it is not on screen.
    await page.keyboard.press('Tab')
    await expect(page.getByRole('link', { name: /pilotflow/ })).toBeFocused()
    await page.keyboard.press('Tab')
    // A disabled voice entry drops out of the tab order rather than trapping it.
    if (await mic.isEnabled()) {
      await expect(mic).toBeFocused()
      await page.keyboard.press('Tab')
    }
    await expect(keyboard).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(controls).toBeFocused()

    // Asking for the keyboard puts the caret in it, so the next key is typed
    // rather than navigating; from the field, Tab reaches its 发送.
    const taskInput = await composer(page)
    await expect(taskInput).toBeFocused()
    const submit = page.getByRole('button', { name: '发送' })
    await page.keyboard.press('Tab')
    await expect(submit).toBeFocused()
    await page.keyboard.press('Enter')
    // The accepted message takes its keyboard with it.
    await expect(page.getByLabel('任务输入')).toHaveCount(0)

    const surface = page.getByRole('region', { name: 'Generated task interface' })
    await expect(surface).toBeVisible()
    await expect(surface).toHaveAttribute('data-layout', 'stack')
    // The opening screen offers the arrivals board rather than asking for a number.
    const board = surface.locator('[data-component-type="flight-choices"]')
    await expect(board).toBeVisible()
    await expect(board.getByRole('listitem')).toHaveCount(5)
    // The composer is open-ended content between header and journey, so a phase
    // holding one is where the fixed frame is most likely to be pushed past the fold.
    await expectNoScroll(page)

    // The keyboard left with its words, so it is out of the tab order too. What
    // follows the header is the board itself: a choice offered on screen has to be
    // reachable without touching it.
    await controls.focus()
    await page.keyboard.press('Tab')
    await expect(page.getByLabel('任务输入')).toHaveCount(0)
    await expect(board.getByRole('button').first()).toBeFocused()

    await sendText(page, 'MU5102')
    // The demo player lives in the drawer, so tabbing on from the header reaches
    // the trip surface's own action rather than a demo control.
    const startNavigation = page.getByRole('button', { name: '开始导航' })
    await expect(startNavigation).toBeEnabled()
    await controls.focus()
    await page.keyboard.press('Tab')
    await expect(startNavigation).toBeFocused()
    await page.keyboard.press('Enter')
    await readControls(page, 'driving-to-airport')
    await expectNoScroll(page)
  }
})

/**
 * The Fixed Frame Rule has a width half that `expectNoScroll` does not cover: it
 * measures each box against the viewport, so it would pass a drawer that squeezed
 * the brief narrower without overflowing anything. Comparing the brief's own width
 * across the open/close boundary is what actually pins "the drawer overlays, it
 * does not reflow".
 */
async function briefWidth(page: Page) {
  const box = await page.locator('.task-surface').boundingBox()
  expect(box).not.toBeNull()
  return Math.round(box?.width ?? 0)
}

/**
 * The fixed-frame rule is a claim about every phase, not just the one the surface
 * happens to open on, so this walks the whole demo timeline and re-checks both
 * axes after each phase change. It runs at 1280x720 and at 1920x720 — the
 * resolution DESIGN.md actually names — through the tagged 1920 project.
 */
test('keeps the brief inside the fixed frame through every phase @layout', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: '打开演示控制' })).toBeVisible()
  await expectNoScroll(page)

  await sendText(page)
  await expectNoScroll(page)
  await sendText(page, 'MU5102')
  // The calendar strip is the fourth brief sharing the preparing frame: it must
  // actually appear, carry the family calendar fact, stay quiet on the happy
  // path, and fit inside the fixed frame with the three briefs above it.
  const scheduleStrip = page.locator('.ui-card--schedule-strip')
  await expect(scheduleStrip).toBeVisible()
  await expect(scheduleStrip).toContainText('豆豆的睡前故事')
  await expect(scheduleStrip).toContainText('21:30')
  await expect(scheduleStrip.locator('.ui-schedule-strip__risk')).toHaveCount(0)
  await expectNoScroll(page)

  await page.getByRole('button', { name: '开始导航' }).click()
  await readControls(page, 'driving-to-airport')
  await expectNoScroll(page)

  // Ten advances cover charging, the landing notice, the geofence, the wait, and
  // the return trip — every renderer component the demo can put on screen.
  for (let step = 0; step < 10; step += 1) {
    await advanceFlow(page)
    await expectNoScroll(page)
  }
  await readControls(page, 'completed')

  // Opening the drawer must not change the brief's width, and the confirmation
  // adds an action pair to the tallest phase in the flow.
  const closedWidth = await briefWidth(page)
  await page.getByRole('button', { name: '打开演示控制' }).click()
  await expect(page.getByRole('dialog', { name: '演示控制' })).toBeVisible()
  expect(await briefWidth(page)).toBe(closedWidth)
  await expectNoScroll(page)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: '演示控制' })).toBeHidden()
  expect(await briefWidth(page)).toBe(closedWidth)
  await expectNoScroll(page)

  await page.getByRole('button', { name: '保存本次偏好' }).click()
  await expect(page.getByRole('button', { name: '保存本次偏好' })).toHaveCount(0)
  await expectNoScroll(page)
})

test('surfaces a transient weather card on demand without growing the preparing frame @layout', async ({ page }) => {
  await page.goto('/')
  await sendText(page)
  await sendText(page, 'MU5102')
  await expect(page.locator('.ui-card--schedule-strip')).toBeVisible()
  const cardCountBefore = await page.locator('.ui-card').count()

  // A whole-utterance weather question is a query turn: it answers on the brief
  // without touching the trip. On the four-card preparing frame the card borrows
  // the schedule strip's slot, so the count must not grow.
  await sendText(page, '到的时候天气怎么样')
  const weatherCard = page.locator('.ui-card--weather-card')
  await expect(weatherCard).toBeVisible()
  await expect(weatherCard).toContainText('虹桥机场 T2')
  await expect(weatherCard).toContainText('小雨')
  await expect(weatherCard).toContainText('室内等候')
  await expect(page.locator('.ui-card--schedule-strip')).toHaveCount(0)
  expect(await page.locator('.ui-card').count()).toBe(cardCountBefore)
  await expectNoScroll(page)

  // The reading is transient: the next trip event recomposes without it and the
  // schedule strip takes its slot back.
  await page.getByRole('button', { name: '开始导航' }).click()
  await readControls(page, 'driving-to-airport')
  await expect(page.locator('.ui-card--weather-card')).toHaveCount(0)
  await expectNoScroll(page)
})

test('surfaces a transient schedule card on demand without growing the preparing frame @layout', async ({ page }) => {
  await page.goto('/')
  await sendText(page)
  await sendText(page, 'MU5102')
  await expect(page.locator('.ui-card--schedule-strip')).toBeVisible()
  const cardCountBefore = await page.locator('.ui-card').count()

  // The second query domain rides the same turn contract as the weather card:
  // it answers on the brief, borrows the strip's slot, and touches no trip fact.
  await sendText(page, '看看我的日程')
  const scheduleCard = page.locator('.ui-card--schedule-card')
  await expect(scheduleCard).toBeVisible()
  await expect(scheduleCard).toContainText('今天的日程')
  await expect(scheduleCard).toContainText('豆豆的睡前故事')
  await expect(scheduleCard).toContainText('21:30')
  await expect(page.locator('.ui-card--schedule-strip')).toHaveCount(0)
  expect(await page.locator('.ui-card').count()).toBe(cardCountBefore)
  await expectNoScroll(page)

  // Transient: the next trip event recomposes without it and the strip returns.
  await page.getByRole('button', { name: '开始导航' }).click()
  await readControls(page, 'driving-to-airport')
  await expect(page.locator('.ui-card--schedule-card')).toHaveCount(0)
  await expectNoScroll(page)
})

test('raises the rain advisory en route and sends the umbrella reminder through confirmation @layout', async ({ page }) => {
  await page.goto('/')
  await sendText(page)
  await sendText(page, 'MU5102')
  await page.getByRole('button', { name: '开始导航' }).click()
  await readControls(page, 'driving-to-airport')

  // The in-air flight update is the moment the arrival window firms up; the
  // forecast finds rain and the advisory takes the rail — a condition raised
  // the prompt, not a timer, and no one asked a question. (vehicle.moving is
  // an advisory timeline step consumed by 开始导航 itself.)
  await advanceFlow(page) // charging.started
  await advanceFlow(page) // flight.updated in-air → advisory
  const advisory = page.locator('[data-component-id="weather-advisory"]')
  await expect(advisory).toBeVisible()
  await expect(advisory).toContainText('小雨')
  await expect(page.getByRole('button', { name: '提醒乘客带伞' })).toBeVisible()
  await expect(page.getByRole('button', { name: '暂不处理' })).toBeVisible()
  await expectNoScroll(page)

  // 提醒乘客带伞 arms the confirm-then-send window: the exact provider-prepared
  // text is on screen, and nothing has been sent yet.
  const prepared = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && /\/v1\/tasks\/[^/]+\/events$/.test(new URL(response.url()).pathname)
  ))
  await page.getByRole('button', { name: '提醒乘客带伞' }).click()
  expect((await prepared).ok()).toBe(true)
  await expect(page.locator('.ui-card--message-preview')).toBeVisible()
  await expect(page.locator('.ui-card--message-preview')).toContainText('带伞')
  await expectNoScroll(page)

  // Confirming goes through the real confirmation API and reports the send.
  const confirmed = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && /\/v1\/tasks\/[^/]+\/confirmations\//.test(new URL(response.url()).pathname)
  ))
  await page.getByRole('button', { name: '确认发送' }).click()
  const confirmation = await confirmed
  expect(confirmation.ok()).toBe(true)
  const result = await confirmation.json()
  expect(result.task.message.status).toBe('sent')
  expect(result.effects).toContainEqual(expect.objectContaining({ type: 'message.send', status: 'succeeded' }))

  // The advisory retired with the answer: the drive is back, and the next
  // trip event does not re-raise it.
  await expect(page.locator('[data-component-id="weather-advisory"]')).toHaveCount(0)
  await advanceFlow(page) // charging.completed
  await expect(page.locator('[data-component-id="weather-advisory"]')).toHaveCount(0)
  await expectNoScroll(page)
})

test('dismissing the rain advisory returns the drive and never re-prompts @layout', async ({ page }) => {
  await page.goto('/')
  await sendText(page)
  await sendText(page, 'MU5102')
  await page.getByRole('button', { name: '开始导航' }).click()
  await readControls(page, 'driving-to-airport')
  await advanceFlow(page) // charging.started
  await advanceFlow(page) // flight.updated in-air → advisory
  await expect(page.locator('[data-component-id="weather-advisory"]')).toBeVisible()

  await page.getByRole('button', { name: '暂不处理' }).click()
  await expect(page.locator('[data-component-id="weather-advisory"]')).toHaveCount(0)
  await expect(page.locator('.ui-card--navigation-summary')).toBeVisible()
  await expectNoScroll(page)
})

test('answers when to leave from the button on the brief without growing the frame @layout', async ({ page }) => {
  await page.goto('/')
  await sendText(page)
  await sendText(page, 'MU5102')
  await expect(page.locator('.ui-card--schedule-strip')).toBeVisible()
  const cardCountBefore = await page.locator('.ui-card').count()

  // The question sits with the card that carries the ETA, beside the number it is
  // about, and travels as ordinary user input — so the button reaches the same
  // planner branch the spoken sentence does. (The card's controls are a sibling
  // of the card surface, so scope to the component wrapper, not the article.)
  const plan = page.locator('.ui-component:has([data-component-id="navigation-plan"])')
  await plan.getByRole('button', { name: '什么时候出发' }).click()

  const departureCard = page.locator('.ui-card--departure-plan')
  await expect(departureCard).toBeVisible()
  await expect(departureCard).toContainText('建议出发')
  await expect(departureCard).toContainText('20:10')
  await expect(departureCard).toContainText('MU5102 20:40 落地')
  await expect(departureCard).toContainText('路上 20 分钟')
  await expect(departureCard).toContainText('提前 10 分钟到')
  await expect(page.locator('.ui-card--schedule-strip')).toHaveCount(0)
  expect(await page.locator('.ui-card').count()).toBe(cardCountBefore)
  await expectNoScroll(page)

  // Same transient contract as the other query answers, and leaving still leads:
  // 开始导航 remains the primary control on the card that hosts the question.
  await page.getByRole('button', { name: '开始导航' }).click()
  await readControls(page, 'driving-to-airport')
  await expect(page.locator('.ui-card--departure-plan')).toHaveCount(0)
  await expectNoScroll(page)
})

/**
 * The two answers the departure card offers, on a real screen.
 *
 * Neither is a shortcut for something already on the brief. 稍后提醒 writes the one
 * thing a question is otherwise not allowed to write — the time the driver was
 * promised — and 查看日程 spends the calendar read the trip already made instead of
 * going back for another. The answer card is transient either way, so a recorded
 * reminder can only show up on the *next* ask, and that is precisely the claim
 * being made here: it was written down, not just said out loud.
 */
test('records the departure reminder and shows the calendar the trip already read @layout', async ({ page }) => {
  await page.goto('/')
  await sendText(page)
  await sendText(page, 'MU5102')

  const plan = page.locator('.ui-component:has([data-component-id="navigation-plan"])')
  // Controls are siblings of the card surface, so the wrapper is what holds both.
  const departure = page.locator('.ui-component:has([data-component-id="departure-plan"])')
  const departureCard = page.locator('.ui-card--departure-plan')

  await plan.getByRole('button', { name: '什么时候出发' }).click()
  await expect(departureCard).toBeVisible()
  await expect(departureCard).not.toContainText('已设提醒')
  await expectNoScroll(page)

  await departure.getByRole('button', { name: '稍后提醒' }).click()
  await expect(departureCard).toHaveCount(0)

  // The same question again, and this time it answers with the promise standing.
  // The reminder carries its own clock rather than being implied by the
  // recommendation, which is what lets it survive a re-read of the route.
  await plan.getByRole('button', { name: '什么时候出发' }).click()
  await expect(departureCard).toBeVisible()
  await expect(departureCard.locator('.ui-departure-plan__reminder')).toHaveText('已设提醒 20:10')
  // Set once and it stays set: the control that would set it again is gone rather
  // than sitting there inert.
  await expect(departure.getByRole('button', { name: '稍后提醒' })).toHaveCount(0)
  await expectNoScroll(page)

  // And the glance at the day, off a read the trip already paid for.
  await departure.getByRole('button', { name: '查看日程' }).click()
  const schedule = page.locator('.ui-card--schedule-card')
  await expect(schedule).toBeVisible()
  await expect(schedule).toContainText('豆豆的睡前故事')
  await expectNoScroll(page)
})

test('reflows the departure answer at phone width instead of cutting its facts off @layout', async ({ page }, testInfo) => {
  // The card is one horizontal band at the demo resolution, which is a shape that
  // only works while there is width to hold it. The 1920x720 project cannot see the
  // other end of that range at all, so it sits this one out rather than repeating
  // the desktop assertion above.
  test.skip(testInfo.project.name === 'chromium-1920x720', 'this spec is about the narrow end of the range')
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/')
  await sendText(page)
  await sendText(page, 'MU5102')
  const plan = page.locator('.ui-component:has([data-component-id="navigation-plan"])')
  await plan.getByRole('button', { name: '什么时候出发' }).click()

  const departureCard = page.locator('.ui-card--departure-plan')
  await expect(departureCard).toBeVisible()
  // Every fact the recommendation was worked backwards from is still readable —
  // including the route, which the middle of the range drops and this end can afford.
  await expect(departureCard).toContainText('20:10')
  await expect(departureCard).toContainText('MU5102 20:40 落地')
  await expect(departureCard).toContainText('路上 20 分钟')
  await expect(departureCard).toContainText('提前 10 分钟到')
  await expect(departureCard).toContainText('直达虹桥机场 T2')

  // `.ui-card` hides its overflow, so containing the text is not the same as showing
  // it: a fact laid out past the card's right edge reads as absent. Measured on the
  // leaves, where the truncation would happen.
  const clipped = await departureCard.evaluate((card) => [...card.querySelectorAll('.ui-departure-plan__fact, .ui-departure-plan__time')]
    .map((element) => ({
      text: (element.textContent ?? '').slice(0, 24),
      clippedWidthBy: element.scrollWidth - element.clientWidth,
    }))
    .filter((box) => box.clippedWidthBy > 1))
  expect(clipped).toEqual([])
  // The phone brief is allowed to scroll, so the frame rule is not the check here;
  // what must not happen is the document growing sideways.
  await expectNoHorizontalOverflow(page)
})

test('answers weather and the calendar from the driving brief without breaking the frame @layout', async ({ page }) => {
  await page.goto('/')
  await sendText(page)
  await sendText(page, 'MU5102')
  await page.getByRole('button', { name: '开始导航' }).click()
  await readControls(page, 'driving-to-airport')
  await expectNoScroll(page)

  const summary = page.locator('.ui-component:has([data-component-id="navigation-summary"])')
  const cardCountBefore = await page.locator('.ui-card').count()

  // Mid-drive, the side scenes are offered on the brief that carries the ETA —
  // the number both answers are relative to. Underway the rail beside the map
  // holds exactly one card, so the answer takes the brief's place for the turn
  // instead of crowding in next to it: same card count, ETA back on the next
  // trip event.
  await summary.getByRole('button', { name: '看下天气' }).click()
  const weatherCard = page.locator('.ui-card--weather-card')
  await expect(weatherCard).toBeVisible()
  await expect(weatherCard).toContainText('虹桥机场 T2')
  await expect(page.locator('.ui-card--route-map')).toBeVisible()
  await expect(summary).toHaveCount(0)
  expect(await page.locator('.ui-card').count()).toBe(cardCountBefore)
  await expectNoScroll(page)

  // Reading one answer must not cost the driver the way back to the other: the
  // answer inherits the buttons from the brief it replaced.
  const weatherComponent = page.locator('.ui-component:has(.ui-card--weather-card)')
  await weatherComponent.getByRole('button', { name: '看看日程' }).click()
  const scheduleCard = page.locator('.ui-card--schedule-card')
  await expect(scheduleCard).toBeVisible()
  await expect(scheduleCard).toContainText('豆豆的睡前故事')
  await expect(page.locator('.ui-card--weather-card')).toHaveCount(0)
  expect(await page.locator('.ui-card').count()).toBe(cardCountBefore)
  await expectNoScroll(page)

  // And the drive itself is still there to go back to.
  await expect(page.locator('.ui-card--route-map')).toBeVisible()
})

/**
 * The media title is the one cabin value that is prose, and prose has no fixed
 * length. The demo can only ever produce two titles — `memory.propose-update`
 * rejects anything outside `knownMediaTitles`, and the shorter of the two filled
 * its column to the pixel — so the flow alone cannot show whether a longer or a
 * mixed-script title still fits. The text is substituted in place for that reason:
 * what is under test is the cascade that lays a string out in that column, and that
 * is a function of the string, not of which tool delivered it.
 *
 * Each candidate is measured on both axes of the leaf, because the two ways this
 * can fail look nothing alike — a title too wide for one line loses its tail to the
 * ellipsis, and a title that wraps grows the shared grid row and can push the card
 * past the fold instead.
 *
 * It sweeps the 680px breakpoint as well, because the column the title has to fit
 * is a different column on either side of it: above, the tracks follow the metric
 * count, and below, the phone-width override lays the same metrics out two to a row.
 * `expectNoScroll` deliberately stops at that breakpoint — DESIGN.md allows a
 * phone-width brief to scroll — but the title still has to fit its own column there,
 * so the leaf is measured at both widths and the frame only above.
 */
test('fits longer and mixed-script media titles in the cabin metric @layout', async ({ page }, testInfo) => {
  await page.goto('/')
  await sendText(page)
  await sendText(page, 'MU5102')
  await page.getByRole('button', { name: '开始导航' }).click()
  for (let step = 0; step < 9; step += 1) await advanceFlow(page)

  const mediaValue = page.locator('.ui-metric', { has: page.getByText('媒体', { exact: true }) })
    .locator('.ui-metric__value')
  await expect(mediaValue).toHaveText('豆豆故事')

  // The 1920x720 project supplies the demo resolution through its own viewport, so
  // resizing here would throw it away; the default project sweeps desktop and phone.
  const viewports = testInfo.project.name === 'chromium-1920x720'
    ? [null]
    : [null, { width: 375, height: 812 }]
  for (const viewport of viewports) {
    if (viewport) await page.setViewportSize(viewport)
    for (const title of [
      // The other title the demo's own preference domain allows.
      '轻音乐',
      // The calendar's wording for the same story, three glyphs longer than the
      // preference's, and the nearest thing to a realistic longer title.
      '豆豆的睡前故事',
      // Latin, digits and CJK in one line, with the spaces the body face has to
      // break on.
      'Peppa Pig 第 3 季',
      // Past one line at any plausible column width: these two prove the wrap, and
      // that the second line is still inside the frame.
      '小猪佩奇与恐龙世界大冒险',
      'The Very Hungry Caterpillar',
    ]) {
      await mediaValue.evaluate((element, text) => {
        const target = element.querySelector('.ui-metric__value-text') ?? element
        target.textContent = text
      }, title)
      await expect(mediaValue).toHaveText(title)
      const fit = await mediaValue.evaluate((element) => ({
        width: document.documentElement.clientWidth,
        // The empty track this fix is about: a grid holding fewer metrics than it
        // has columns spends width on nothing while the title beside it truncates,
        // and that is as true below the breakpoint as above it.
        emptyTracks: getComputedStyle(element.closest('.ui-cabin-grid') as HTMLElement)
          .gridTemplateColumns.split(' ').length
          - (element.closest('.ui-cabin-grid') as HTMLElement).querySelectorAll('.ui-metric').length,
        clippedWidthBy: element.scrollWidth - element.clientWidth,
        clippedBy: element.scrollHeight - element.clientHeight,
      }))
      expect(fit, `媒体 value clipped rendering ${title}`)
        .toEqual({ width: fit.width, emptyTracks: 0, clippedWidthBy: 0, clippedBy: 0 })
      // The whole frame, not just the leaf: a wrapped title takes a second line out
      // of the card's height budget, and the fixed-frame rule holds either way. Below
      // the breakpoint there is no frame rule to hold, and `expectNoScroll` returns
      // early there of its own accord.
      await expectNoScroll(page)
    }
  }

  // The metric count the demo never produces, and the one where the two-column
  // phone override and the metric-count rules actually disagree — at two metrics
  // they happen to want the same thing, so a sweep of the real brief cannot tell
  // which rule is in force. The other metrics are taken out of the grid to ask
  // directly, last, because it is destructive to the brief.
  await mediaValue.evaluate((element) => {
    const grid = element.closest('.ui-cabin-grid') as HTMLElement
    const media = element.closest('.ui-metric') as HTMLElement
    for (const metric of [...grid.querySelectorAll('.ui-metric')]) {
      if (metric !== media) metric.remove()
    }
  })
  for (const viewport of viewports) {
    // Explicit sizes here rather than the sweep's leading `null`: the loop above
    // left the page at the last width it visited, so "the project's own viewport"
    // no longer means what it meant at the start of the test.
    if (viewport) await page.setViewportSize(viewport)
    else if (testInfo.project.name !== 'chromium-1920x720') await page.setViewportSize({ width: 1280, height: 720 })
    const alone = await mediaValue.evaluate((element) => {
      const grid = element.closest('.ui-cabin-grid') as HTMLElement
      return {
        width: document.documentElement.clientWidth,
        tracks: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
        metrics: grid.querySelectorAll('.ui-metric').length,
      }
    })
    expect(alone, 'a lone cabin metric must not leave an empty track')
      .toEqual({ width: alone.width, tracks: 1, metrics: 1 })
  }
})

/**
 * The route panel is a drawing of the UISpec the Agent sent. Two things move it,
 * and the difference between them is the point of this test: a newer spec carries
 * a newer authored progress value, and within one spec the marker crawls between
 * the two ends the fixture authored, at the rate the fixture authored, and stops
 * at the near end of the next stage. Nothing advances past a value the Agent has
 * not sent — a checkpoint with no crawl leaves the marker exactly where it landed.
 *
 * The renderer unit tests pin the geometry maths and drive the crawl frame by
 * frame; only a real browser shows the drawing is actually painted, given a column
 * of its own with height in it, foldable where it floats, and still inside the
 * fixed frame at the demo resolution.
 */
test('draws the offline route panel and steps its marker on authored progress @layout', async ({ page }) => {
  await page.goto('/')
  await sendText(page)
  await sendText(page, 'MU5102')

  const panel = page.locator('.ui-card--route-map')
  const vehicle = panel.locator('.ui-route-map__vehicle')
  const line = panel.locator('.ui-route-map__line')
  const progress = panel.locator('.ui-route-map__progress')

  // 准备出发 is a full-width brief of three detail cards: a 64%-width map beside
  // three wide cards would break the fixed frame, so the map waits for its own
  // screen. The planned route rides inside the navigation card until then.
  await expect(page.getByRole('button', { name: '开始导航' })).toBeEnabled()
  await expect(panel).toHaveCount(0)
  await expect(page.locator('.ui-layout--split')).toHaveCount(0)
  await expectNoScroll(page)

  await page.getByRole('button', { name: '开始导航' }).click()
  await readControls(page, 'driving-to-airport')
  // 前往机场 gives the route its own column: the map appears, following the part
  // of the trip the driver is on.
  await expect(panel).toBeVisible()
  await expect(panel).toHaveAttribute('data-route-progress', 'simulated')
  await expect(panel).toHaveAttribute('data-route-map-mode', 'follow')
  // The panel is drawn offline from fixture points, never from a map SDK.
  await expect(panel).toHaveAttribute('data-route-map-source', 'sketch')
  await expect(page.getByRole('img', { name: '前往虹桥机场 T2的路线示意' })).toBeVisible()
  // The departed checkpoint authors a crawl from 8% to 34%, so there is no single
  // number to assert: by the time the browser has painted, some of the span has
  // already been covered. What the fixture does promise is the two ends, so the
  // reading has to start inside them — a marker that jumped to the destination, or
  // one the renderer had not placed at all, fails here.
  const percentage = async () => Number(/(\d+)%/.exec((await progress.textContent()) ?? '')?.[1])
  const departedPercent = await percentage()
  expect(departedPercent).toBeGreaterThanOrEqual(8)
  expect(departedPercent).toBeLessThanOrEqual(34)
  // And it has to actually move, which is the whole reason the crawl exists: a car
  // under way and frozen until the next event reads as a broken demo. One authored
  // percent takes about 3.5s at the fixture's rate.
  await expect.poll(percentage, { timeout: 15_000 }).toBeGreaterThan(departedPercent)
  expect(await percentage()).toBeLessThanOrEqual(34)
  // The map has a column to itself, so the split really did survive to the DOM.
  await expect(page.locator('.ui-layout--split')).toBeVisible()
  // Visible is not enough for an SVG: a canvas collapsed to zero height would
  // still report visible while drawing nothing the driver can see. A panel has
  // to be taller than the 72px band it replaced to be worth its column.
  const canvas = await panel.locator('.ui-route-map__canvas').boundingBox()
  expect(canvas?.height ?? 0).toBeGreaterThan(120)

  // Above the breakpoint the brief stops being a column beside the map and
  // becomes a panel floating over it, which is a failure mode `expectNoScroll`
  // cannot see: it measures clipping and overflow, and one box laid over another
  // overflows nothing. 模拟行程进度 sits at the right end of the map's caption,
  // exactly where the panel lands, so measure the gap between them directly.
  const glass = page.locator('.ui-slot--secondary .ui-card--navigation-summary')
  await expect(glass).toBeVisible()
  const glassBox = await glass.boundingBox()
  const mapBox = await panel.boundingBox()
  expect(glassBox).not.toBeNull()
  expect(mapBox).not.toBeNull()
  // First that the takeover happened at all. It is guarded on the rail holding a
  // single card, and a guard that quietly stops matching would leave an ordinary
  // two-column split — which still fits the frame and still clears the caption,
  // so every other assertion here would go on passing over a silent revert.
  expect(glassBox!.x).toBeGreaterThan(mapBox!.x)
  expect(glassBox!.x + glassBox!.width).toBeLessThanOrEqual(mapBox!.x + mapBox!.width)

  const captionEnd = await progress.boundingBox()
  expect(captionEnd).not.toBeNull()
  expect(captionEnd!.x + captionEnd!.width).toBeLessThanOrEqual(glassBox!.x)

  // What folding does is asserted in the `@glass` spec below, on all three
  // engines. What only this spec can ask is whether each of its states fits the
  // frame — so the fold is driven here for the frame's sake alone.
  const fold = glass.getByRole('button', { name: '收起面板' })
  await fold.click()
  await expect(glass).toHaveAttribute('data-panel', 'collapsed')
  // Less panel cannot mean more page.
  await expectNoScroll(page)

  await page.setViewportSize({ width: 1024, height: 720 })
  await expect(page.locator('.ui-navigation-brief__fold')).toBeHidden()
  await expectNoScroll(page)

  await page.setViewportSize({ width: 1920, height: 720 })
  await glass.getByRole('button', { name: '展开面板' }).click()
  await expect(glass).toHaveAttribute('data-panel', 'expanded')
  await expectNoScroll(page)

  const departedLine = await line.getAttribute('d')
  const departedAt = await vehicle.getAttribute('transform')
  await expectNoScroll(page)

  // One advance of the shared timeline, one newer authored value: the marker steps
  // along the same drawn route. This checkpoint authors no crawl — the car has
  // stopped to charge — so unlike the departed one it is a single exact number.
  await advanceFlow(page) // charging.started
  await expect(progress).toHaveText('模拟行程进度 40%')
  expect(await vehicle.getAttribute('transform')).not.toBe(departedAt)
  expect(await line.getAttribute('d')).toBe(departedLine)
  await expectNoScroll(page)

  // No authored span, no movement: waiting on a still page leaves the marker
  // exactly where the last spec put it. This is what keeps the crawl a reading of
  // the fixture rather than a timer of its own — a driver watching a charging car
  // creep down the route would be watching the UI invent a position.
  const steppedAt = await vehicle.getAttribute('transform')
  await page.waitForTimeout(1200)
  expect(await vehicle.getAttribute('transform')).toBe(steppedAt)
  await expect(progress).toHaveText('模拟行程进度 40%')

  // A simulated drawing says so: no copy claims a live position, and no internal
  // route identifier reaches the brief.
  for (const claim of ['实时位置', '正在此处', '当前位置', '实时路况']) {
    await expect(panel).not.toContainText(claim)
  }
  await expect(page.locator('.task-surface')).not.toContainText('route-airport')

  // Narrower than the split's breakpoint the map keeps a band of the fold rather
  // than disappearing, and the frame still holds with one column.
  await page.setViewportSize({ width: 1024, height: 720 })
  await expect(panel).toBeVisible()
  expect((await panel.boundingBox())?.height ?? 0).toBeGreaterThan(80)
  await expectNoScroll(page)
  await page.setViewportSize({ width: 1920, height: 720 })

  // Later phases put other cards on the brief; losing the drawing costs the
  // drawing alone and the frame still holds.
  await advanceFlow(page) // flight in-air
  await advanceFlow(page) // charging.completed
  await expect(page.getByText(/补能完成/)).toBeVisible()
  await expect(panel).toHaveCount(0)
  await expectNoScroll(page)
})

/**
 * The panel over the map, on every engine CI can install.
 *
 * Everything asserted here is a browser question rather than a code question:
 * whether `:has()` matched and turned the split into a takeover, whether the
 * `display: contents` group the fold controls actually disappears, whether the
 * rail's `pointer-events: none` is taken back by the panel, and whether the
 * tier tokens the blur reads reach the shell. A unit test can assert the markup
 * for all four and be wrong about every one of them.
 *
 * Held apart from the `@layout` walk on purpose. That spec asks the harder and
 * broader question — does the whole brief fit a 1920x720 frame — and Gecko
 * answers no today for a reason that predates the panel: with no
 * `SpeechRecognition` the composer is on screen from the first frame and its
 * ~140px is not in the frame's budget (CONTRIBUTING.md records it). Gating the
 * panel on that spec would mean gating it on an unrelated known failure, so the
 * engine-sensitive assertions get a spec of their own and the frame assertions
 * stay where they are.
 */
test('floats, folds, and tiers the panel the same way on every engine @glass', async ({ page }) => {
  // Set here rather than left to the project so the three engines are compared
  // at one width, and so this spec means the same thing in every project it runs in.
  await page.setViewportSize({ width: 1920, height: 720 })
  await page.goto('/')
  await sendText(page)
  await sendText(page, 'MU5102')
  await page.getByRole('button', { name: '开始导航' }).click()
  await readControls(page, 'driving-to-airport')

  const map = page.locator('.ui-card--route-map')
  const glass = page.locator('.ui-slot--secondary .ui-card--navigation-summary')
  await expect(map).toBeVisible()
  await expect(glass).toBeVisible()

  // The takeover is a `:has()` match. An engine that did not make it leaves an
  // ordinary two-column split, where the panel sits beside the map instead of
  // inside its bounds — which is what these two assertions tell apart.
  const glassBox = await glass.boundingBox()
  const mapBox = await map.boundingBox()
  expect(glassBox).not.toBeNull()
  expect(mapBox).not.toBeNull()
  expect(glassBox!.x).toBeGreaterThan(mapBox!.x)
  expect(glassBox!.x + glassBox!.width).toBeLessThanOrEqual(mapBox!.x + mapBox!.width)

  // The rail turns pointer events off so the map behind stays draggable, and the
  // panel takes them back. Ask the browser what a click at the panel's own centre
  // would land on: anything under the glass means the panel is inert.
  const hit = await page.evaluate(() => {
    const card = document.querySelector('.ui-slot--secondary .ui-card--navigation-summary')
    if (!card) return 'no panel'
    const box = card.getBoundingClientRect()
    const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return target?.closest('.ui-slot--secondary') ? 'panel' : (target?.tagName.toLowerCase() ?? 'nothing')
  })
  expect(hit).toBe('panel')

  const fold = glass.getByRole('button', { name: '收起面板' })
  const band = glass.locator('.ui-navigation-brief__route-rule')
  const facts = glass.locator('.ui-navigation-brief__facts')
  const eta = glass.locator('.ui-navigation-eta')
  await expect(fold).toBeVisible()
  // The card hides its own overflow, so a card given less height than its
  // contents does not scroll — it silently cuts them off, and the first thing off
  // the top is the header the fold lives in. Gecko sized it that way until the
  // panel started asking for `max-content`: the fold was drawn 30px above the
  // card's own box, clipped out of it, and unclickable while still looking fine
  // in a screenshot. Nothing visible can be outside the box it is painted in.
  expect(await glass.evaluate((card) => card.scrollHeight - card.clientHeight)).toBe(0)
  // 44px is the touch target this is drawn to; a control the driver has to aim
  // at is not a control in a moving car. Rounded because the engines disagree in
  // the last decimal — WebKit lays the same 44px box out as 43.99998 — and a
  // hundredth of a pixel is not a thumb missing a button.
  const foldBox = await fold.boundingBox()
  expect(Math.round(foldBox?.width ?? 0)).toBeGreaterThanOrEqual(44)
  expect(Math.round(foldBox?.height ?? 0)).toBeGreaterThanOrEqual(44)

  await fold.click()
  await expect(glass).toHaveAttribute('data-panel', 'collapsed')
  // The hidden group has `display: contents` and so no box of its own for an
  // engine to call visible; its two children are what the driver sees go away.
  await expect(band).toBeHidden()
  await expect(facts).toBeHidden()
  await expect(eta).toBeVisible()
  await expect(glass).toContainText('虹桥机场 T2')
  const foldedBox = await glass.boundingBox()
  expect(foldedBox!.height).toBeLessThan(glassBox!.height)

  // Folded, then narrowed below the width where the panel exists at all. The fold
  // goes with it, so the card has to come back whole rather than stranding the
  // driver with a collapsed card and no control to reopen it.
  await page.setViewportSize({ width: 1024, height: 720 })
  await expect(page.locator('.ui-navigation-brief__fold')).toBeHidden()
  await expect(band).toBeVisible()
  await expect(facts).toBeVisible()

  await page.setViewportSize({ width: 1920, height: 720 })
  await expect(glass).toHaveAttribute('data-panel', 'collapsed')
  await glass.getByRole('button', { name: '展开面板' }).click()
  await expect(glass).toHaveAttribute('data-panel', 'expanded')
  await expect(band).toBeVisible()
  await expect(facts).toBeVisible()

  // The tier is decided from what the device reports, so the value differs by
  // machine and only the contract is assertable: one of the three tiers is on the
  // shell, and the two custom properties the blur reads resolve to something.
  const tier = await page.locator('.demo-shell').getAttribute('data-glass')
  expect(['full', 'reduced', 'none']).toContain(tier)
  const tokens = await page.locator('.demo-shell').evaluate((shell) => {
    const styles = getComputedStyle(shell)
    return { blur: styles.getPropertyValue('--glass-blur').trim(), saturate: styles.getPropertyValue('--glass-saturate').trim() }
  })
  expect(tokens.blur).toMatch(/^\d+px$/)
  expect(tokens.saturate).not.toBe('')
})

test('completes the airport pickup flow through the Agent API', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  // Without a task there is nothing to advance, and the drawer says so.
  await expectAdvanceEnabled(page, false)
  await readControls(page, '尚无任务')

  await sendText(page)
  await readControls(page, 'collecting-information')
  await expectAdvanceEnabled(page, true)

  await sendText(page, 'MU5102')
  await readControls(page, 'preparing')
  await page.getByRole('button', { name: '开始导航' }).click()

  await readControls(page, 'driving-to-airport')
  await readControls(page, 'navigation.start:succeeded')

  await advanceFlow(page) // charging.started
  await readControls(page, 'driving-to-airport')
  const inAir = await advanceFlow(page)
  expect(inAir.task.flight.status).toBe('in-air')
  await advanceFlow(page) // charging.completed
  await expect(page.getByText(/补能完成/)).toBeVisible()
  await advanceFlow(page) // flight landed
  await expect(page.getByRole('heading', { level: 1 })).toContainText('落地通知')
  await advanceFlow(page) // message.sent
  await readControls(page, 'message.send:succeeded')
  await advanceFlow(page) // airport geofence
  await readControls(page, 'approaching-airport')
  await advanceFlow(page) // parked
  await readControls(page, 'waiting-for-passengers')
  await advanceFlow(page) // passengers onboard
  await readControls(page, 'returning-home')
  await readControls(page, 'navigation.update-route:succeeded')
  await readControls(page, 'vehicle.apply-cabin-profile:succeeded')
  await readControls(page, 'media.play:succeeded')
  await advanceFlow(page) // cabin preference input
  await advanceFlow(page) // destination.arrived
  await readControls(page, 'completed')
  await readControls(page, 'memory.propose-update:pending-confirmation')

  await page.getByRole('button', { name: '保存本次偏好' }).click()
  await readControls(page, 'memory.confirm-update:succeeded')
  await expect(page.getByRole('button', { name: '保存本次偏好' })).toHaveCount(0)
})

test('prepares the trip from a flight picked off the arrivals board', async ({ page }) => {
  await page.goto('/')
  await sendText(page)
  await readControls(page, 'collecting-information')

  // The board is the Agent's answer to a pickup with no flight number yet, and
  // every row it offers has to be one the trip can actually be prepared from.
  const row = page.locator('.ui-flight-choices__row', { hasText: 'CA1516' })
  await expect(row).toBeEnabled()
  await row.click()

  await readControls(page, 'preparing')
  const flightCard = page.locator('.ui-card--flight-status')
  await expect(flightCard).toContainText('CA1516')
  // The choice has been made, so the offer is gone rather than sitting under the brief.
  await expect(page.locator('.ui-flight-choices')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '开始导航' })).toBeEnabled()
})

test('prepares the trip from a spoken ordinal against the rendered board', async ({ page }) => {
  await page.goto('/')
  await sendText(page)
  await readControls(page, 'collecting-information')

  // 第三个 must mean the third row the driver is looking at — read it off the
  // rendered board rather than assuming fixture order.
  const rows = page.locator('.ui-flight-choices__row')
  const thirdOnScreen = (await rows.nth(2).textContent())?.match(/[A-Z]{2}\d{4}/)?.[0]
  expect(thirdOnScreen).toBeTruthy()

  await sendText(page, '选第三个')
  await readControls(page, 'preparing')
  await expect(page.locator('.ui-card--flight-status')).toContainText(thirdOnScreen!)
  await expect(page.locator('.ui-flight-choices')).toHaveCount(0)
})

/**
 * The board offers a choice of airport now, and both halves of that choice need
 * proving on a real screen.
 *
 * 浦东 is east of the demo origin where 虹桥 is west, so the direction the route
 * line runs is what says the drive actually followed the row that was pressed —
 * a destination label can be wrong and still read correctly, a compass direction
 * cannot. Both picks are walked, because "east" only means anything against the
 * other one.
 *
 * Then the refresh the board now carries. Re-reading the arrivals mints the
 * candidate set again and moves the task on, so a rank aimed at the list the
 * driver was looking at a moment earlier is refused outright rather than resolved
 * against whatever is on screen now. Silently picking the third row of a different
 * board is the failure the identity exists to prevent, so the refusal is asserted
 * together with the state that was not touched.
 */
test('follows a 浦东 pick east, and refuses a rank aimed at the board before a refresh', async ({ page }) => {
  await page.goto('/')
  const createResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/v1/tasks'
  ))
  await sendText(page)
  const created = await (await createResponsePromise).json()
  expect(created.task.flightDiscovery.candidateSetId).toMatch(/^cs-/)

  // One board, two airports: the choice is a difference between rows rather than
  // between queries, which is what makes it answerable off a single list.
  const rows = page.locator('.ui-flight-choices__row')
  await expect(rows.filter({ hasText: '虹桥机场' }).first()).toBeVisible()
  const pudong = rows.filter({ hasText: '浦东机场' }).first()
  await expect(pudong).toBeEnabled()

  // The refresh, pressed the way the driver would. It travels as the same words
  // the composer would have sent, so the board is re-read and the task moves.
  const refreshResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && /\/v1\/tasks\/[^/]+\/events$/.test(new URL(response.url()).pathname)
  ))
  await page.getByRole('button', { name: '刷新航班' }).click()
  const refreshed = await (await refreshResponsePromise).json()
  expect(refreshed.task.taskRevision).toBeGreaterThan(created.task.taskRevision)
  expect(refreshed.task.flightDiscovery.candidateSetId).toMatch(/^cs-/)
  await expect(page.locator('.ui-flight-choices')).toBeVisible()
  await expect(rows.first()).toBeEnabled()

  // 选第三个, against the list as it stood before that refresh — it carries the
  // revision it was planned against and is refused for it.
  const stale = await postApi(page, `/v1/tasks/${created.task.taskId}/events`, {
    clientRequestId: 'e2e-stale-rank',
    expectedTaskRevision: created.task.taskRevision,
    event: {
      eventId: 'e2e-stale-rank',
      type: 'user.input',
      text: '选第三个',
      timestamp: futureTimestamp(),
    },
  })
  expect(stale.status()).toBe(409)
  await expect(stale.json()).resolves.toMatchObject({ error: { code: 'TASK_REVISION_CONFLICT' } })
  // Refused rather than half-applied: no flight was chosen by that rank, and the
  // board the driver is looking at is still the one to choose from.
  await expect(page.locator('.ui-card--flight-status')).toHaveCount(0)
  await expect(page.locator('.ui-flight-choices')).toBeVisible()
  await readControls(page, 'collecting-information')

  // And the pick that does land, off the board actually on screen.
  const pudongFlight = await pudong.getAttribute('data-flight-number')
  await pudong.click()
  await readControls(page, 'preparing')
  await expect(page.locator('.ui-card--flight-status')).toContainText(pudongFlight!)

  await page.getByRole('button', { name: '开始导航' }).click()
  await readControls(page, 'driving-to-airport')
  await expect(page.getByRole('img', { name: '前往浦东机场 T2的路线示意' })).toBeVisible()
  expect(await routeLineDirection(page)).toBe('east')

  // The contrast, on a trip of its own: same panel, other airport, other way out
  // of the frame. Nothing is carried over — a reload starts from 尚无任务.
  await page.goto('/')
  await sendText(page)
  await page.locator('.ui-flight-choices__row', { hasText: 'MU5102' }).click()
  await readControls(page, 'preparing')
  await page.getByRole('button', { name: '开始导航' }).click()
  await readControls(page, 'driving-to-airport')
  await expect(page.getByRole('img', { name: '前往虹桥机场 T2的路线示意' })).toBeVisible()
  expect(await routeLineDirection(page)).toBe('west')
})

/**
 * The whole scenario in one pass, driver-side only: the trip is asked for in
 * words, the flight is picked off a board, the departure time is asked about, the
 * drive begins, two side scenes are read on the way, and the airport is reached.
 * Every other e2e here enters somewhere in the middle with the flight number
 * already typed; this is the only one that walks the arc a driver actually walks,
 * and its job is to catch a seam between two steps that each pass alone.
 *
 * It measures the frame at every generative screen, because the sequence is where
 * a layout regression hides: a card composed correctly on its own can still be the
 * second card in a slot that only holds one.
 */
test('walks the pickup scenario from the arrivals board to the airport @layout', async ({ page }) => {
  await page.goto('/')

  // 1 — the intent, in words. No flight number yet, on purpose.
  await sendText(page)
  await readControls(page, 'collecting-information')
  await expectNoScroll(page)

  // 2 — the Agent answers with the arrivals it can actually prepare a trip from,
  // as a board rather than a question.
  const board = page.locator('.ui-card--flight-choices')
  await expect(board).toBeVisible()
  const rows = page.locator('.ui-flight-choices__row')
  expect(await rows.count()).toBeGreaterThan(1)
  await expectNoScroll(page)

  // 3 — the driver picks one, tapped off the board rather than typed. It is the
  // demo's own flight because the rest of the arc is the timeline authored for it;
  // that a different row prepares just as well is what the arrivals-board test
  // above is for.
  await page.locator('.ui-flight-choices__row', { hasText: 'MU5102' }).click()
  await readControls(page, 'preparing')
  await expect(page.locator('.ui-card--flight-status')).toContainText('MU5102')
  await expect(board).toHaveCount(0)
  await expectNoScroll(page)

  // 4 — before leaving, the one question the brief cannot answer by itself.
  await page
    .locator('.ui-component:has([data-component-id="navigation-plan"])')
    .getByRole('button', { name: '什么时候出发' })
    .click()
  const departure = page.locator('.ui-card--departure-plan')
  await expect(departure).toBeVisible()
  await expect(departure).toContainText('落地')
  await expectNoScroll(page)

  // 5 — and then the drive, which is where the generative screen becomes a cockpit.
  await page.getByRole('button', { name: '开始导航' }).click()
  await readControls(page, 'driving-to-airport')
  await expect(page.locator('.ui-card--route-map')).toBeVisible()
  // The question was transient: it left with the turn, unasked-for state and all.
  await expect(departure).toHaveCount(0)
  await expectNoScroll(page)

  // 6 and 7 — the side scenes, read off the brief without leaving the drive.
  const summary = page.locator('.ui-component:has([data-component-id="navigation-summary"])')
  await summary.getByRole('button', { name: '看下天气' }).click()
  await expect(page.locator('.ui-card--weather-card')).toBeVisible()
  await expect(page.locator('.ui-card--route-map')).toBeVisible()
  await expectNoScroll(page)

  await page
    .locator('.ui-component:has(.ui-card--weather-card)')
    .getByRole('button', { name: '看看日程' })
    .click()
  await expect(page.locator('.ui-card--schedule-card')).toBeVisible()
  await expectNoScroll(page)

  // 8 — the trip carries on from where it was. Asking wrote nothing, so the next
  // real event restores the brief and the arc continues to the airport.
  await advanceFlow(page) // charging.started
  await expect(summary).toHaveCount(1)
  await expect(page.locator('.ui-card--schedule-card')).toHaveCount(0)
  await advanceFlow(page) // flight in-air
  await advanceFlow(page) // charging.completed
  await advanceFlow(page) // flight landed
  await advanceFlow(page) // message.sent
  await advanceFlow(page) // airport geofence
  await readControls(page, 'approaching-airport')
  await expectNoScroll(page)
  await advanceFlow(page) // parked
  await readControls(page, 'waiting-for-passengers')
  await expectNoScroll(page)

  // Nothing internal reached the driver anywhere along the way.
  await expect(page.locator('.task-surface')).not.toContainText('route-airport')
  await expect(page.locator('.task-surface')).not.toContainText('flight.list-arrivals')
})

test('keeps the task usable around a voice attempt', async ({ page }) => {
  await page.goto('/')
  const mic = page.getByRole('button', { name: /开始语音输入|语音入口暂不可用/ })
  await expect(mic).toBeVisible()

  // Headless Chromium exposes the Web Speech API but has no speech service
  // behind it, so the outcome of a real turn is not deterministic. What must
  // hold is that pressing the microphone never strands the driver: the entry
  // returns to a usable state and the text path still completes the turn.
  if (await mic.isEnabled()) {
    await mic.click()
    // The keyboard is closed on purpose while the microphone is capturing, so
    // end the turn before typing. A second press either hands back a transcript
    // or reports that nothing was heard; either way the keyboard reopens.
    const capturing = page.getByRole('button', { name: '停止语音输入' })
    if (await capturing.isVisible()) await capturing.click()
    await expect(
      page.getByRole('button', { name: /开始语音输入|重试语音输入|放弃这次语音输入/ }),
    ).toBeEnabled()
    // Whatever that turn did, a keyboard is reachable: either the failure has
    // already opened one — in which case the toggle is deliberately unable to
    // take it away — or the 文字 entry can still bring one up.
    const fieldAlreadyOpen = await page.getByLabel('任务输入').count() > 0
    if (!fieldAlreadyOpen) {
      await expect(page.getByRole('button', { name: '改用文字输入' })).toBeEnabled()
    }
  }

  await sendText(page)
  await readControls(page, 'collecting-information')
})

test('falls back to text when the browser has no speech recognition', async ({ page }) => {
  await page.addInitScript(() => {
    const scope = window as unknown as Record<string, unknown>
    delete scope.SpeechRecognition
    delete scope.webkitSpeechRecognition
  })
  await page.goto('/')

  const mic = page.getByRole('button', { name: '语音入口暂不可用' })
  await expect(mic).toBeVisible()
  await expect(mic).toBeDisabled()

  await sendText(page, '我现在要去机场接妈妈和豆豆')
  await readControls(page, 'collecting-information')
})

test('replays a fixture utterance deterministically from the demo drawer', async ({ page }) => {
  await page.goto('/')

  // The offline fallback must not depend on a speech service or on the audio
  // actually playing: the drawer replay delivers the canonical transcript from
  // fixtures/airport-pickup/voice either way, parked for confirmation.
  await page.getByRole('button', { name: '打开演示控制' }).click()
  const drawer = page.getByRole('dialog', { name: '演示控制' })
  await expect(drawer).toContainText('语音兜底回放')
  await page.getByRole('button', { name: '接机指令' }).click()
  await expect(drawer).toBeHidden()

  // Nothing auto-submits: the words wait in the field until 发送 confirms them.
  // The recording may genuinely play first, so allow it time to finish.
  const input = page.getByLabel('任务输入')
  await expect(input).toHaveValue('我现在要去机场接妈妈和豆豆', { timeout: 15_000 })

  const createResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/v1/tasks'
  ))
  await page.getByRole('button', { name: '发送' }).click()
  const created = await (await createResponsePromise).json()
  expect(created.task.phase).toBe('collecting-information')
  await readControls(page, 'collecting-information')
})

test('applies an out-of-band task update through the durable SSE stream', async ({ page }) => {
  await page.goto('/')
  const createResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/v1/tasks'
  ))
  await sendText(page)
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
  await readControls(page, 'driving-to-airport')
})

test('rejects the arrival memory proposal through the confirmation API', async ({ page }) => {
  await page.goto('/')

  await sendText(page)
  await sendText(page, 'MU5102')
  await page.getByRole('button', { name: '开始导航' }).click()

  for (let step = 0; step < 10; step += 1) await advanceFlow(page)
  await readControls(page, 'completed')
  await page.getByRole('button', { name: '暂不保存' }).click()

  await readControls(page, 'memory.reject-update:cancelled')
  await expect(page.getByRole('button', { name: '暂不保存' })).toHaveCount(0)
})

/**
 * Rewrites the demo's landing flight to MU5103, the number the preview server's
 * E2E provider fails `message.send` for, so the auto notify ends in `failed`
 * rather than `sent`.
 */
async function failAutoLandingNotice(page: Page) {
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
}

test('retries a failed landing message through action and confirmation APIs', async ({ page }) => {
  await failAutoLandingNotice(page)
  await page.goto('/')

  await sendText(page)
  await sendText(page, 'MU5102')
  await page.getByRole('button', { name: '开始导航' }).click()
  await readControls(page, 'driving-to-airport')
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
  await expect(page.getByRole('heading', { level: 1 })).toContainText('落地通知失败')
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
  await readControls(page, 'message.send:succeeded')
  await expect(page.getByRole('button', { name: '确认发送' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '重试发送' })).toHaveCount(0)
})

/**
 * A failed message must keep showing its send status in `minimal` density. The
 * unit test pins the DOM structure; only a real browser applies the stylesheet
 * that hides `.ui-detail-row` at that density, so this asserts the status is
 * actually painted rather than merely present.
 *
 * Reaching `minimal` in the browser takes a highway speed: `applyRequestPresentation`
 * recomputes density from `vehicleContext.speedKph` (> 60 -> minimal) and overrides
 * whatever the composer chose, and the demo's own timeline never exceeds 30 kph.
 */
test('keeps a failed message send status visible in minimal density @layout', async ({ page }) => {
  await failAutoLandingNotice(page)
  await page.goto('/')

  await sendText(page)
  await sendText(page, 'MU5102')
  await page.getByRole('button', { name: '开始导航' }).click()
  await advanceFlow(page) // charging.started
  await advanceFlow(page) // flight in-air
  await advanceFlow(page) // charging.completed
  await advanceFlow(page) // flight landed
  const failedSend = await advanceFlow(page) // message.send provider returns SEND_FAILED
  expect(failedSend).toMatchObject({ task: { message: { status: 'failed' } } })
  await expect(page.getByText('发送失败')).toBeVisible()

  // A context-only sensor event: it moves the car onto the highway without
  // advancing the phase, so the same failed message is re-rendered at minimal.
  const moving = await postApi(page, `/v1/tasks/${failedSend.task.taskId}/events`, {
    clientRequestId: 'e2e-minimal-density-moving',
    expectedTaskRevision: failedSend.task.taskRevision,
    event: {
      eventId: 'e2e-minimal-density-moving',
      type: 'vehicle.moving',
      speedKph: 80,
      timestamp: futureTimestamp(30),
    },
  })
  expect(moving.ok()).toBe(true)
  await expect(moving.json()).resolves.toMatchObject({
    task: { message: { status: 'failed' } },
    ui: { presentation: { density: 'minimal' } },
  })

  const surface = page.getByRole('region', { name: 'Generated task interface' })
  await expect(surface).toHaveAttribute('data-density', 'minimal')
  // The conclusion and its recovery action both survive the density change.
  await expect(page.getByText('发送失败')).toBeVisible()
  await expect(page.getByRole('button', { name: '重试发送' })).toBeVisible()
  // Belt and braces: visible is not enough if the stylesheet collapsed the row to
  // zero height, so assert the status actually occupies space.
  const box = await page.getByText('发送失败').boundingBox()
  expect(box?.height ?? 0).toBeGreaterThan(0)
  await expectNoScroll(page)
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

test('does not create a landing notification when no passenger authorized one', async ({ page }) => {
  await page.goto('/')
  const createdResponse = await postApi(page, '/v1/tasks', {
    clientRequestId: 'e2e-no-notify-authority-create',
    input: { type: 'text', text: '接爸爸，航班 MU5102' },
    ...apiRequest,
  })
  expect(createdResponse.status()).toBe(201)
  const created = await createdResponse.json()
  expect(created.task.passengers).toMatchObject({ memberIds: ['dad'], names: ['爸爸'] })

  const landedResponse = await postApi(page, `/v1/tasks/${created.task.taskId}/events`, {
    clientRequestId: 'e2e-no-notify-authority-landed',
    expectedTaskRevision: created.task.taskRevision,
    event: {
      eventId: 'e2e-no-notify-authority-landed',
      type: 'flight.updated',
      flight: {
        flightNumber: 'MU5102', status: 'landed',
        scheduledArrival: '2026-07-22T20:30:00+08:00',
        estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2',
      },
      timestamp: futureTimestamp(2),
    },
  })
  expect(landedResponse.status()).toBe(200)
  await expect(landedResponse.json()).resolves.toMatchObject({
    task: { message: { autoNotifyAuthorized: false, status: 'idle', landingNoticeSent: false } },
    effects: [],
  })
})

test('shows a deterministic fallback when the flight provider times out', async ({ page }) => {
  await page.goto('/')
  await sendText(page, '接妈妈，航班 MU0000')

  await expect(page.getByRole('region', { name: 'Generated task interface' })).toContainText('数据暂时不可用')
  await expect(page.getByRole('region', { name: 'Generated task interface' })).toContainText('请稍后重试')
  await readControls(page, 'preparing')
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
