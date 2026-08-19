import { defineConfig, devices } from '@playwright/test';

// The unit suite covers pure logic; these specs cover the parts of the mobile
// experience that only exist once a real engine is laying out and dispatching
// touch events. Kept on its own script so `npm test` stays fast.

// A dedicated port keeps this off the default 1071 install and, because
// config.js derives the database path from the port, gives the run its own
// tc-<port>.db instead of writing into real data.
const PORT = Number(process.env.E2E_PORT || 1099);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // Gesture assertions read back a transform that settles over a few frames,
  // so give expect.poll room without making a genuine failure slow.
  expect: { timeout: 5000 },
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    // Two shapes rather than two engines: a notched iOS-sized viewport and a
    // taller Android one. Both run on Chromium, since WebKit and Firefox
    // downloads are a heavier ask than this suite justifies; the maths that
    // differs per device is viewport size, which emulation reproduces.
    {
      name: 'iphone',
      use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium', isMobile: true, hasTouch: true },
    },
    {
      name: 'pixel',
      use: { ...devices['Pixel 5'], defaultBrowserType: 'chromium', isMobile: true, hasTouch: true },
    },
  ],

  webServer: {
    command: 'node src/index.js',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
    env: {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
    },
  },
});
