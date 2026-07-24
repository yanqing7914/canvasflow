import { expect, test } from '@playwright/test'

test('renders the fixture task card and advances the phase', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: '机场接人任务卡片' })).toBeVisible()

  const console = page.getByRole('region', { name: 'Event console' })
  // Demo player starts from the shared main-flow timeline.
  await expect(console).toContainText('collecting-information')

  // task-created → flight-number → charging-recommended → route-airport
  for (let step = 0; step < 4; step += 1) {
    await page.getByRole('button', { name: '推进下一事件' }).click()
  }

  await expect(console).toContainText('driving-to-airport')
})
