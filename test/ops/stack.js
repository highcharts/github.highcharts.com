'use strict'

const express = require('express')
const { createOpsConsoleRouter } = require('../../app/ops/console-router')
const { OpsRateLimiter, SessionStore } = require('../../app/ops/sessions')
const { createRouter } = require('../../app/router')

const port = Number(process.env.PORT || 8080)
const internalToken = process.env.INTERNAL_SERVICE_TOKEN
let clockOffset = 0
const now = () => Date.now() + clockOffset
const sessions = new SessionStore({ now })
const rateLimiter = new OpsRateLimiter({ now })
const events = []
const publicRouter = createRouter({ disableRateLimit: true, now })
const app = express()

if (!internalToken) throw new Error('INTERNAL_SERVICE_TOKEN is required')

// Published Docker traffic arrives from a bridge address; this harness models the
// production direct-loopback listener before invoking the real trust-boundary code.
app.use((request, response, next) => {
  Object.defineProperty(request.socket, 'remoteAddress', { configurable: true, value: '127.0.0.1' })
  next()
})
app.use('/__ops-test', express.json({ limit: '4kb' }), testControls)
app.use('/_ops', createOpsConsoleRouter({
  env: process.env,
  log: event => {
    events.push(event)
    console.log(JSON.stringify(event)) // eslint-disable-line no-console
  },
  now,
  sessions,
  rateLimiter,
  routerService: { snapshot: publicRouter.opsSnapshot }
}))
app.use(publicRouter)
app.listen(port, '0.0.0.0')

async function testControls (request, response) {
  try {
    if (request.method === 'POST' && request.path === '/fixture') {
      const { service, snapshot, cache, resetCounts } = request.body || {}
      if (!['downloader', 'builder'].includes(service)) return response.sendStatus(400)
      const result = await fixture(service, '/__ops-test/control', {
        method: 'POST',
        body: { snapshot, cache, resetCounts }
      })
      return response.json(result)
    }
    if (request.method === 'POST' && request.path === '/clock') {
      const milliseconds = request.body?.advanceMs
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 9 * 60 * 60 * 1000) return response.sendStatus(400)
      clockOffset += milliseconds
      return response.json({ ok: true })
    }
    if (request.method === 'POST' && request.path === '/rotate') {
      sessions.rotate()
      return response.json({ ok: true })
    }
    if (request.method === 'POST' && request.path === '/reset-audits') {
      events.splice(0)
      return response.json({ ok: true })
    }
    if (request.method === 'GET' && request.path === '/status') {
      const [downloader, builder] = await Promise.all([
        fixture('downloader', '/__ops-test/status'),
        fixture('builder', '/__ops-test/status')
      ])
      const audits = events.filter(event => event.action === 'cache_operation')
      return response.json({
        audits: audits.length,
        auditSafe: audits.every(auditIsSafe),
        downloader: downloader.calls,
        builder: builder.calls
      })
    }
    response.sendStatus(404)
  } catch (error) {
    response.status(502).json({ error: 'fixture unavailable' })
  }
}

async function fixture (service, path, options = {}) {
  const result = await fetch(`http://${service}:8080${path}`, {
    method: options.method,
    headers: {
      Authorization: `Bearer ${internalToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  })
  if (!result.ok) throw new Error('Fixture request failed')
  return result.json()
}

function auditIsSafe (event) {
  const encoded = JSON.stringify(event)
  return event.action === 'cache_operation' &&
    !encoded.includes(process.env.OPS_TEST_LOGIN_TOKEN || '\u0000') &&
    !encoded.includes(process.env.OPS_CONSOLE_TOKEN_VERIFIER || '\u0000') &&
    !encoded.includes(internalToken) &&
    !/(authorization|cookie|csrfToken|token)/i.test(encoded) &&
    Buffer.byteLength(encoded) < 65536
}
