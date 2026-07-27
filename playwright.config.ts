import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.PLAYWRIGHT_PORT ?? 4173)
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chromium',
      },
    },
  ],
  webServer: {
    command: 'npm run build && npm run preview',
    env: {
      ...process.env,
      AGENT_DATABASE_PATH: ':memory:',
      CANVASFLOW_E2E: '1',
      AGENT_E2E_FAIL_AUTO_MESSAGE_SEND: '1',
      AGENT_PORT: String(port),
    },
    reuseExistingServer: false,
    url: baseURL,
    timeout: 120_000,
  },
})
