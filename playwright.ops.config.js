'use strict'

const { defineConfig, devices } = require('@playwright/test')

module.exports = defineConfig({
  testDir: './test/browser',
  testMatch: 'ops.spec.js',
  fullyParallel: false,
  workers: 1,
  timeout: 60 * 1000,
  expect: { timeout: 10 * 1000 },
  reporter: process.env.CI ? 'dot' : 'list',
  outputDir: 'tmp/playwright-ops-results',
  use: {
    baseURL: process.env.OPS_TEST_BASE_URL || 'http://localhost:8080',
    trace: 'off',
    screenshot: 'off',
    video: 'off'
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } }
  ]
})
