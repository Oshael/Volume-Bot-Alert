const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/smoke',
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  workers: 1,
  timeout: 20_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm --prefix frontend run dev -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
