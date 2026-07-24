import { expect, test } from '@playwright/test'

test('creates a task through Agent API and advances to airport navigation', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: '机场接人任务卡片' })).toBeVisible()

  await page.getByRole('button', { name: '发送' }).click()
  const console = page.getByRole('region', { name: 'Event console' })
  await expect(console).toContainText('collecting-information')

  await page.getByLabel('任务输入').fill('MU5102')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(console).toContainText('preparing')
  await page.getByRole('button', { name: '开始导航' }).click()

  await expect(console).toContainText('driving-to-airport')
  await expect(page.getByLabel('Effect receipts')).toContainText('navigation.start:succeeded')
})
