import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.PLAYWRIGHT_PORT ?? 4173)
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './tests/e2e',
  // Several specs walk the entire demo flow (create -> ten advances -> memory
  // confirmation) with layout assertions between steps. With both projects
  // sharing one preview server and one CPU, each advance costs 2-3s and the
  // walk overruns the 30s default — the test then dies mid-loop looking like a
  // lost click or a stalled server. Real hangs still fail fast through the 5s
  // expect timeout; only the honest end-to-end walking time gets this budget.
  timeout: 60_000,
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
    // DESIGN.md names 1920x720 as the demo resolution and forbids both scroll
    // axes there. `Desktop Chrome` is 1280x720, so without this project the
    // layout rules are only ever asserted at a narrower width than the one the
    // demo actually runs at. Specs that assert layout carry @layout.
    {
      name: 'chromium-1920x720',
      grep: /@layout/,
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chromium',
        viewport: { width: 1920, height: 720 },
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
