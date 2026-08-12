import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.PLAYWRIGHT_PORT ?? 4173)
const baseURL = `http://127.0.0.1:${port}`

/**
 * The wider `@layout` sweep on the other two engines, opt-in.
 *
 * Opt-in and not required because two of its specs fail on Gecko today for a
 * reason that has nothing to do with layout: Firefox has no `SpeechRecognition`,
 * so the demo falls back to the text composer, and the composer is on screen from
 * the first frame where Chromium and WebKit only show it on request. Its ~140px
 * is outside the 720px frame budget, so every `expectNoScroll` in the walk fails.
 * CONTRIBUTING.md records both that and the keyboard sweep's known differences.
 *
 * Making the whole sweep required would mean gating every PR on those; making it
 * disappear would leave the engine-sensitive CSS untested. So the part that is
 * genuinely an engine question is carved out as `@glass` below and required,
 * and the rest stays here for a deliberate local run:
 *
 *   npx playwright install webkit firefox
 *   PLAYWRIGHT_CROSS_BROWSER=1 npx playwright test --grep @layout
 */
const crossBrowser = process.env.PLAYWRIGHT_CROSS_BROWSER === '1'

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
    // The floating panel is the one part of the demo whose correctness is an
    // engine question rather than a code question: `:has()` decides whether the
    // panel exists at all, `display: contents` decides whether folding hides
    // anything, and `backdrop-filter` decides whether the result is legible.
    // Each is implemented slightly differently by WebKit and Gecko, and every
    // failure mode is visual, so nothing in the unit suite can see them. These
    // two run on every PR — the `@glass` spec deliberately asserts the panel's
    // behaviour and not the frame, so it is clear of the Gecko composer issue
    // above and can be required without gating on an unrelated known failure.
    {
      name: 'webkit-glass',
      grep: /@glass/,
      use: { ...devices['Desktop Safari'], viewport: { width: 1920, height: 720 } },
    },
    {
      name: 'firefox-glass',
      grep: /@glass/,
      use: { ...devices['Desktop Firefox'], viewport: { width: 1920, height: 720 } },
    },
    // Both at the demo resolution, so a difference between engines is a
    // difference in the layout and not in the width it was measured at.
    ...(crossBrowser
      ? [
        {
          name: 'webkit-1920x720',
          grep: /@layout/,
          use: { ...devices['Desktop Safari'], viewport: { width: 1920, height: 720 } },
        },
        {
          name: 'firefox-1920x720',
          grep: /@layout/,
          use: { ...devices['Desktop Firefox'], viewport: { width: 1920, height: 720 } },
        },
      ]
      : []),
  ],
  webServer: {
    command: 'npm run build && npm run preview',
    env: {
      ...process.env,
      AGENT_DATABASE_PATH: ':memory:',
      CANVASFLOW_E2E: '1',
      CANVASFLOW_E2E_NOW: '2026-08-11T09:30:00+08:00',
      AGENT_E2E_FAIL_AUTO_MESSAGE_SEND: '1',
      AGENT_PORT: String(port),
      // The browser mock owns the API implementation. A public, non-secret
      // sentinel only lets the production loader take its normal configured
      // path instead of honestly choosing the no-key fallback.
      VITE_AMAP_JS_KEY: 'canvasflow-e2e-mock-key',
    },
    reuseExistingServer: false,
    url: baseURL,
    timeout: 120_000,
  },
})
