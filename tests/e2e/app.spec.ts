import { expect, test } from '@playwright/test'

test('loads the production build and generates a flow step', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'CanvasFlow' })).toBeVisible()
  await page.getByRole('button', { name: /generate flow/i }).click()
  await expect(page.getByRole('heading', { name: 'Adaptive checkout canvas' })).toBeVisible()
})
