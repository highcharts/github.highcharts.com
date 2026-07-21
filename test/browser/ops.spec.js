'use strict'

const { test, expect } = require('@playwright/test')
const AxeBuilder = require('@axe-core/playwright').default
const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')

const root = resolve(__dirname, '../..')
const composeFile = 'compose.ops-test.yaml'
const project = `ops-console-browser-${process.pid}`
const port = Number(process.env.OPS_TEST_HOST_PORT || 8080)
const baseURL = `http://localhost:${port}`
const loginToken = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const axeTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => {
  inspectTopology()
  compose(['up', '--build', '--wait', '--remove-orphans'])
})

test.afterAll(() => {
  compose(['down', '--volumes', '--remove-orphans'], {}, true)
})

test.beforeEach(async ({ context, page }) => {
  await context.clearCookies()
  await control('/fixture', { service: 'downloader', snapshot: 'fresh', cache: 'healthy', resetCounts: true })
  await control('/fixture', { service: 'builder', snapshot: 'fresh', cache: 'healthy', resetCounts: true })
  await page.goto('/_ops/login')
})

test('authenticates, renders snapshots, mutates caches, and scans key states', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Operations console' })).toBeFocused()
  await axe(page)

  await login(page)
  await waitForOverview(page)
  await expect(page.getByRole('heading', { name: 'Service status' })).toBeVisible()
  await expect(page.locator('#services')).toContainText('Router')
  await expect(page.locator('#services')).toContainText('Downloader')
  await expect(page.locator('#services')).toContainText('Builder')
  await expect(page.locator('#services')).toContainText('Fresh')
  await axe(page)

  await page.getByRole('button', { name: 'Purge expired downloader' }).click()
  await expect(page.getByRole('region', { name: 'Cache operation result' })).toBeFocused()
  await expect(page.locator('#operation-content')).toContainText('No action needed')
  await expect(page.locator('#operation-content')).toContainText('Cache purge expired')
  await expect(page.locator('#operation-content')).toContainText('Downloader')
  await expect(page.locator('#operation-content')).toContainText('Removed')
  await waitForOverview(page)
  await expect(page.locator('#session-status')).toContainText('Idle expiry')
  await axe(page)
})

test('shows stale, unavailable, expiry, and logout auth states', async ({ page }) => {
  await login(page)
  await waitForOverview(page)

  await control('/fixture', { service: 'downloader', snapshot: 'slow' })
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.locator('#services')).toContainText('Stale', { timeout: 15000 })

  compose(['down', '--volumes', '--remove-orphans'], {}, true)
  compose(['up', '--build', '--wait', '--remove-orphans'])
  await control('/fixture', { service: 'downloader', snapshot: 'fresh', cache: 'healthy', resetCounts: true })
  await control('/fixture', { service: 'builder', snapshot: 'disconnect' })
  await page.goto('/_ops/login')
  await login(page)
  await waitForOverview(page)
  await expect(page.locator('#aggregate-warning')).toContainText('Partial snapshot')
  await expect(page.locator('#services')).toContainText('No current service values')

  await control('/clock', { advanceMs: 31 * 60 * 1000 })
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page).toHaveURL(/\/_ops\/login$/)

  await login(page)
  await waitForOverview(page)
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/_ops\/login$/)
})

test('keeps keyboard flow and narrow, zoomed, reduced-motion layouts usable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 320, height: 720 })
  await login(page)
  await waitForOverview(page)

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await page.keyboard.press('Tab')
  await expect(page.locator('.skip-link')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#main$/)

  await page.setViewportSize({ width: 640, height: 720 })
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Service status' })).toBeVisible()
})

test('keeps focus on manual refresh while snapshot refresh completes', async ({ page }) => {
  await login(page)
  await waitForOverview(page)
  await control('/fixture', { service: 'downloader', snapshot: 'slow' })

  const refresh = page.getByRole('button', { name: 'Refresh' })
  await refresh.focus()
  await refresh.press('Enter')

  await expect(page.locator('#services')).toHaveAttribute('aria-busy', 'true')
  await expect(page.locator('#connection-status')).toContainText('Refreshing')
  await expect(refresh).toBeFocused()
  await waitForOverview(page)
  await expect(refresh).toBeFocused()
})

async function login (page) {
  await page.getByLabel('Operations token').fill(loginToken)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/_ops\/$/)
}

async function waitForOverview (page) {
  await expect(page.locator('#services')).toHaveAttribute('aria-busy', 'false')
  await expect(page.getByText('Waiting for the first snapshot')).toBeHidden()
}

async function axe (page) {
  const results = await new AxeBuilder({ page }).withTags(axeTags).analyze()
  expect(results.violations).toEqual([])
}

async function control (path, body) {
  const response = await fetch(`${baseURL}/__ops-test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!response.ok) throw new Error(`test control ${path} failed`)
}

function inspectTopology () {
  const config = JSON.parse(compose(['config', '--format', 'json'], {}, true))
  const published = Object.entries(config.services).filter(([, service]) => service.ports?.length)
  if (published.length !== 1 || published[0][0] !== 'router' || published[0][1].ports.length !== 1 || Number(published[0][1].ports[0].target) !== 8080) {
    throw new Error('only router:8080 may be published')
  }
  for (const name of ['downloader', 'builder']) {
    if (config.services[name].ports?.length) throw new Error(`${name} publishes a port`)
  }
}

function compose (args, environment = {}, quiet = false) {
  const result = spawnSync('docker', ['compose', '-p', project, '-f', composeFile, ...args], {
    cwd: root,
    env: { ...process.env, OPS_TEST_HOST_PORT: String(port), ...environment },
    encoding: 'utf8',
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`docker exited with ${result.status}`)
  return quiet ? result.stdout : ''
}
