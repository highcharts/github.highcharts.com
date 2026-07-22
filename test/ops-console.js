'use strict'

const { expect } = require('chai')
const { randomBytes } = require('node:crypto')
const http = require('node:http')
const express = require('express')
const { describe, it } = require('mocha')
const { createTokenVerifier } = require('../app/ops/config')
const { createOpsConsoleRouter } = require('../app/ops/console-router')
const { SECURITY_HEADERS } = require('../app/ops/http')
const { SESSION_CAPACITY, SessionStore } = require('../app/ops/sessions')
const { LIMITS } = require('../app/ops/telemetry')
const { createApp } = require('../app/server')

describe('operations console router', () => {
  const origin = 'http://127.0.0.1:8080'
  const enabled = (token, overrides = {}) => ({
    OPS_CONSOLE_ENABLED: 'true',
    OPS_CONSOLE_TOKEN_VERIFIER: createTokenVerifier(token),
    OPS_CONSOLE_ORIGIN: origin,
    OPS_CONSOLE_ALLOW_HTTP_LOOPBACK: 'true',
    ...overrides
  })

  it('reserves every disabled path before legacy and public middleware and logs one safe status', async () => {
    const events = []
    let publicCalls = 0
    const publicRouter = express.Router().use((request, response) => {
      publicCalls++
      response.sendStatus(200)
    })
    const app = createApp({ ops: { env: {}, log: event => events.push(event) }, router: publicRouter })

    for (const path of ['/_ops', '/_ops/', '/_ops/login', '/_ops/console.css', '/_ops/console.js', '/_ops/login.js', '/_ops/api/v1/session', '/_ops/anything']) {
      const response = await request(app, { path })
      expect(response.status).to.equal(404)
      expectSecurityHeaders(response.headers)
    }
    expect(publicCalls).to.equal(0)
    expect(events).to.have.length(1)
    expect(events[0]).to.include({ action: 'operations_console_status', enabled: false })
    expect(Object.keys(events[0])).to.have.members(['time', 'action', 'enabled'])
  })

  it('serves only the enabled login page and allow-listed assets without authentication', async () => {
    const token = randomBytes(32).toString('base64url')
    const app = opsApp({ env: enabled(token), log: () => {} })
    const files = [
      ['/_ops/login', 'text/html', '<form id="login-form">'],
      ['/_ops/console.css', 'text/css', '.login-panel'],
      ['/_ops/console.js', 'application/javascript', "const API = '/_ops/api/v1'"],
      ['/_ops/login.js', 'application/javascript', "window.location.replace('/_ops/')"]
    ]

    for (const [path, contentType, marker] of files) {
      const response = await request(app, { path })
      expect(response.status).to.equal(200)
      expect(response.headers['content-type']).to.include(contentType)
      expect(response.body).to.include(marker)
      expectSecurityHeaders(response.headers)
      expect(response.headers).not.to.have.property('access-control-allow-origin')
    }
  })

  it('allows direct address-bar console documents and rejects none elsewhere', async () => {
    const token = randomBytes(32).toString('base64url')
    const app = opsApp({ env: enabled(token), log: () => {} })
    const navigation = {
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Dest': 'document'
    }

    expect((await request(app, { path: '/_ops/login?direct=1', headers: navigation })).status).to.equal(200)
    const shell = await request(app, { path: '/_ops/?direct=1', headers: navigation })
    expect(shell.status).to.equal(302)
    expect(shell.headers.location).to.equal('/_ops/login')

    for (const [method, path] of [
      ['GET', '/_ops/console.css'],
      ['GET', '/_ops/api/v1/session'],
      ['POST', '/_ops/api/v1/session'],
      ['DELETE', '/_ops/api/v1/session'],
      ['GET', '/_ops/unknown'],
      ['GET', '/_ops/%2e%2e/config.json']
    ]) {
      const response = await request(app, { method, path, headers: navigation })
      expect(response).to.nested.include({ status: 403, 'json.error.code': 'FETCH_METADATA_REJECTED' })
      expectSecurityHeaders(response.headers)
    }
  })

  it('serves only self-hosted static behavior without inline code or browser storage', async () => {
    const token = randomBytes(32).toString('base64url')
    const app = opsApp({ env: enabled(token), log: () => {} })
    const authenticated = await login(app, token)
    const responses = await Promise.all([
      request(app, { path: '/_ops/login' }),
      request(app, { path: '/_ops/', headers: { Cookie: cookiePair(authenticated) } }),
      request(app, { path: '/_ops/console.css' }),
      request(app, { path: '/_ops/console.js' }),
      request(app, { path: '/_ops/login.js' })
    ])
    const assets = responses.map(response => response.body).join('\n')

    expect(responses.every(response => response.status === 200)).to.equal(true)
    expect(assets).not.to.match(/https?:\/\/|<style\b|\sstyle=|\son\w+=/i)
    expect(assets).not.to.match(/localStorage|sessionStorage|serviceWorker|indexedDB|analytics|gtag/i)
    for (const html of responses.slice(0, 2).map(response => response.body)) {
      expect([...html.matchAll(/<script\b([^>]*)>/gi)].every(match => /src="\/_ops\/(?:console|login)\.js"/.test(match[1]))).to.equal(true)
      expect([...html.matchAll(/<link\b([^>]*)>/gi)].every(match => /href="\/_ops\/console\.css"/.test(match[1]))).to.equal(true)
    }
  })

  it('protects the exact UI shell without renewing its session', async () => {
    const token = randomBytes(32).toString('base64url')
    let now = Date.parse('2026-07-20T12:00:00.000Z')
    const app = opsApp({ env: enabled(token), log: () => {}, now: () => now })

    const anonymous = await request(app, { path: '/_ops/' })
    expect(anonymous.status).to.equal(302)
    expect(anonymous.headers.location).to.equal('/_ops/login')
    expect(anonymous.body).not.to.include('UNAUTHORIZED')
    expectSecurityHeaders(anonymous.headers)

    const invalid = await request(app, { path: '/_ops/', headers: { Cookie: 'ghhc-console-dev=invalid' } })
    expect(invalid.status).to.equal(302)
    expect(invalid.headers.location).to.equal('/_ops/login')

    const authenticated = await login(app, token)
    const cookie = cookiePair(authenticated)
    now += 29 * 60 * 1000
    const shell = await request(app, { path: '/_ops/', headers: { Cookie: cookie } })
    expect(shell.status).to.equal(200)
    expect(shell.headers['content-type']).to.include('text/html')
    expect(shell.body).to.include('<h1>Operations console</h1>')
    expectSecurityHeaders(shell.headers)

    now += 2 * 60 * 1000
    expect((await request(app, { path: '/_ops/api/v1/session', headers: { Cookie: cookie } }))).to.nested.include({
      status: 401,
      'json.error.code': 'UNAUTHORIZED'
    })
  })

  it('does not serve, leak, or redirect unknown and traversal-like static paths', async () => {
    const token = randomBytes(32).toString('base64url')
    const app = opsApp({ env: enabled(token), log: () => {} })

    for (const path of ['/_ops', '/_ops/unknown', '/_ops/static/', '/_ops/console.css/', '/_ops/.hidden', '/_ops/%2e%2e/config.json']) {
      const response = await request(app, { path })
      expect(response.status).to.equal(404)
      expect(response.headers).not.to.have.property('location')
      expect(response.body).not.to.include('downloaderURL')
      expectSecurityHeaders(response.headers)
    }

    const api = await request(app, { path: '/_ops/api/v1/unknown' })
    expect(api).to.nested.include({ status: 404, 'json.error.code': 'NOT_FOUND' })
    expect(api.json.error.correlationId).to.equal(api.headers['x-correlation-id'])
  })

  it('creates, bootstraps, and revokes a loopback HTTP session', async () => {
    const token = randomBytes(32).toString('base64url')
    const events = []
    const app = opsApp({ env: enabled(token), log: event => events.push(event) })
    const login = await request(app, {
      method: 'POST',
      path: '/_ops/api/v1/session',
      headers: { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ token })
    })

    expect(login.status).to.equal(201)
    expect(login.headers['set-cookie']).to.have.length(1)
    expect(login.headers['set-cookie'][0]).to.match(/^ghhc-console-dev=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/$/)
    expect(login.headers['set-cookie'][0]).not.to.include('Secure')
    expect(login.json).to.include({ authenticated: true })
    expect(login.json.csrfToken).to.match(/^[A-Za-z0-9_-]{43}$/)
    expect(login.headers['x-correlation-id']).to.match(/^[0-9a-f-]{36}$/)
    expect(events).to.have.length(1)

    const cookie = cookiePair(login)
    const status = await request(app, { path: '/_ops/api/v1/session', headers: { Cookie: cookie } })
    expect(status.status).to.equal(200)
    expect(status.json).to.include({
      authenticated: true,
      absoluteExpiresAt: login.json.absoluteExpiresAt,
      csrfToken: login.json.csrfToken
    })
    expect(Date.parse(status.json.idleExpiresAt)).to.be.at.least(Date.parse(login.json.idleExpiresAt))

    const rejectedLogout = await request(app, {
      method: 'DELETE',
      path: '/_ops/api/v1/session',
      headers: { Cookie: cookie, Origin: origin, 'X-Ops-CSRF': 'wrong' }
    })
    expect(rejectedLogout).to.nested.include({ status: 403, 'json.error.code': 'CSRF_REJECTED' })

    const logout = await request(app, {
      method: 'DELETE',
      path: '/_ops/api/v1/session',
      headers: { Cookie: cookie, Origin: origin, 'X-Ops-CSRF': login.json.csrfToken }
    })
    expect(logout.status).to.equal(204)
    expect(logout.body).to.equal('')
    expect(logout.headers['set-cookie'][0]).to.equal('ghhc-console-dev=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/')
    expect((await request(app, { path: '/_ops/api/v1/session', headers: { Cookie: cookie } }))).to.nested.include({
      status: 401,
      'json.error.code': 'UNAUTHORIZED'
    })
  })

  it('returns generic authentication failures without reflecting credentials', async () => {
    const token = randomBytes(32).toString('base64url')
    const wrongToken = randomBytes(32).toString('base64url')
    const app = opsApp({ env: enabled(token), log: () => {} })

    for (const body of [JSON.stringify({ token: wrongToken }), JSON.stringify({ token, extra: true })]) {
      const response = await request(app, {
        method: 'POST',
        path: '/_ops/api/v1/session',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body
      })
      expect(response.status).to.equal(401)
      expect(response.json.error).to.include({ code: 'UNAUTHORIZED', message: 'Authentication failed' })
      expect(response.body).not.to.include(token)
      expect(response.body).not.to.include(wrongToken)
    }
  })

  it('enforces context, Origin, Fetch Metadata, content type, and body bounds', async () => {
    const token = randomBytes(32).toString('base64url')
    const app = opsApp({ env: enabled(token), log: () => {} })
    const attempt = headers => request(app, {
      method: 'POST',
      path: '/_ops/api/v1/session',
      headers,
      body: JSON.stringify({ token })
    })

    expect(await attempt({ 'Content-Type': 'application/json' })).to.nested.include({ status: 403, 'json.error.code': 'ORIGIN_REJECTED' })
    expect(await attempt({ Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' })).to.nested.include({ status: 403, 'json.error.code': 'FETCH_METADATA_REJECTED' })
    expect(await attempt({ Origin: origin, 'Content-Type': 'text/plain' })).to.nested.include({ status: 415, 'json.error.code': 'UNSUPPORTED_MEDIA_TYPE' })

    const oversized = await request(app, {
      method: 'POST',
      path: '/_ops/api/v1/session',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, padding: 'x'.repeat(4096) })
    })
    expect(oversized).to.nested.include({ status: 413, 'json.error.code': 'PAYLOAD_TOO_LARGE' })
  })

  it('rotates an existing session only after successful authentication', async () => {
    const token = randomBytes(32).toString('base64url')
    const app = opsApp({ env: enabled(token), log: () => {} })
    const first = await login(app, token)
    const firstCookie = cookiePair(first)
    const failed = await login(app, randomBytes(32).toString('base64url'), firstCookie)
    expect(failed.status).to.equal(401)
    expect((await request(app, { path: '/_ops/api/v1/session', headers: { Cookie: firstCookie } })).status).to.equal(200)

    const replacement = await login(app, token, firstCookie)
    expect(replacement.status).to.equal(201)
    expect(cookiePair(replacement)).not.to.equal(firstCookie)
    expect((await request(app, { path: '/_ops/api/v1/session', headers: { Cookie: firstCookie } })).status).to.equal(401)
    expect((await request(app, { path: '/_ops/api/v1/session', headers: { Cookie: cookiePair(replacement) } })).status).to.equal(200)
  })

  it('enforces login rate and session capacity without evicting sessions', async () => {
    const token = randomBytes(32).toString('base64url')
    const rateApp = opsApp({ env: enabled(token), log: () => {} })
    for (let index = 0; index < 30; index++) {
      const headers = { 'X-Forwarded-For': `192.0.2.${index + 1}`, 'X-Forwarded-Proto': 'https' }
      expect((await login(rateApp, randomBytes(32).toString('base64url'), undefined, headers)).status).to.equal(401)
    }
    const limited = await login(rateApp, token)
    expect(limited).to.nested.include({ status: 429, 'json.error.code': 'RATE_LIMITED' })
    expect(limited.headers['retry-after']).to.equal('900')

    const store = new SessionStore()
    for (let index = 0; index < SESSION_CAPACITY; index++) store.create()
    const capacityApp = opsApp({ env: enabled(token), log: () => {}, sessions: store })
    const capacity = await login(capacityApp, token)
    expect(capacity).to.nested.include({ status: 503, 'json.error.code': 'SESSION_CAPACITY' })
    expect(store.size).to.equal(SESSION_CAPACITY)
  })

  it('expires sessions, rejects ambiguous cookies, and does not renew on HEAD', async () => {
    const token = randomBytes(32).toString('base64url')
    let now = Date.parse('2026-07-20T12:00:00.000Z')
    const app = opsApp({ env: enabled(token), log: () => {}, now: () => now })
    const created = await login(app, token)
    const cookie = cookiePair(created)
    expect((await request(app, { method: 'HEAD', path: '/_ops/api/v1/session', headers: { Cookie: cookie } })).status).to.equal(404)
    expect((await request(app, { path: '/_ops/api/v1/session', headers: { Cookie: `${cookie}; ${cookie}` } })).status).to.equal(401)
    now += 30 * 60 * 1000
    expect((await request(app, { path: '/_ops/api/v1/session', headers: { Cookie: cookie } })).status).to.equal(401)
  })

  it('authenticates, concurrently aggregates bounded snapshots, and propagates one correlation ID', async () => {
    const token = randomBytes(32).toString('base64url')
    const started = new Set()
    const calls = []
    const observedAt = new Date().toISOString()
    const makeProvider = (service, value) => async options => {
      started.add(service)
      calls.push({ service, options })
      await new Promise(resolve => setImmediate(resolve))
      expect([...started]).to.have.members(['router', 'downloader', 'builder'])
      return value
    }
    const routerSnapshot = serviceSnapshot('router', observedAt, {
      activity: [activity('public-request', 'router', 'public_file_delivery')]
    })
    const downloaderSnapshot = serviceSnapshot('downloader', observedAt, {
      activity: [activity('public-request', 'downloader', 'file_download')],
      failures: [failure('public-request', 'downloader', 'file_download')]
    })
    const app = opsApp({
      env: enabled(token),
      log: () => {},
      routerService: { snapshot: makeProvider('router', routerSnapshot) },
      downloader: { json: (path, options) => makeProvider('downloader', downloaderSnapshot)(options) },
      builder: { json: (path, options) => makeProvider('builder', serviceSnapshot('builder', observedAt))(options) }
    })
    const authenticated = await login(app, token)
    const cookie = cookiePair(authenticated)

    expect(await request(app, { path: '/_ops/api/v1/snapshot' })).to.nested.include({ status: 401, 'json.error.code': 'UNAUTHORIZED' })
    expect(await request(app, { path: '/_ops/api/v1/snapshot', headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' } })).to.nested.include({ status: 403, 'json.error.code': 'FETCH_METADATA_REJECTED' })
    expect((await request(app, { method: 'HEAD', path: '/_ops/api/v1/snapshot', headers: { Cookie: cookie } })).status).to.equal(404)

    const snapshot = await request(app, { path: '/_ops/api/v1/snapshot', headers: { Cookie: cookie, 'X-Correlation-ID': 'browser-value' } })
    expect(snapshot.status).to.equal(200)
    expect(snapshot.headers['x-correlation-id']).to.match(/^[0-9a-f-]{36}$/).and.not.equal('browser-value')
    expect(snapshot.json).to.include({ schemaVersion: 1, correlationId: snapshot.headers['x-correlation-id'], refreshAfterMs: 30000 })
    expect(snapshot.json.services.downloader).to.include({ freshness: 'fresh', error: null })
    expect(snapshot.json.services.builder).to.include({ freshness: 'fresh', error: null })
    expect(snapshot.json.activity).to.have.length(1)
    expect(snapshot.json.activity[0].spans.map(span => span.service)).to.have.members(['router', 'downloader'])
    expect(snapshot.json.failures).to.have.length(1)
    expect(snapshot.json.services.router.snapshot.capabilities.find(capability => capability.name === 'console_cache_control')).to.include({ status: 'available', reasonCode: null })
    expect(calls.filter(call => call.service !== 'router')).to.have.length(2)
    for (const call of calls.filter(call => call.service !== 'router')) {
      expect(call.options).to.include({
        correlationId: snapshot.json.correlationId,
        maxResponseBytes: 1024 * 1024,
        timeout: 1500,
        timeoutThroughBody: true
      })
    }
    expect(JSON.stringify(snapshot.json)).not.to.include('browser-value')
  })

  it('retains last-success snapshots across failures, expires stale data, and replaces restarted instances', async () => {
    const token = randomBytes(32).toString('base64url')
    let now = Date.parse('2026-07-20T12:00:00.000Z')
    let downloaderFails = false
    let builderInstance = 'builder-1'
    const currentSnapshot = (service, instanceId = `${service}-1`) => serviceSnapshot(service, new Date(now).toISOString(), { instanceId })
    const app = opsApp({
      env: enabled(token),
      log: () => {},
      now: () => now,
      routerService: { snapshot: () => currentSnapshot('router') },
      downloader: { json: () => downloaderFails ? Promise.reject(new Error('secret /path')) : Promise.resolve(currentSnapshot('downloader')) },
      builder: { json: () => Promise.resolve(currentSnapshot('builder', builderInstance)) }
    })
    const authenticated = await login(app, token)
    const headers = { Cookie: cookiePair(authenticated) }
    const fresh = await request(app, { path: '/_ops/api/v1/snapshot', headers })
    expect(fresh.json.services.downloader).to.include({ freshness: 'fresh', ageMs: 0 })

    now += 1000
    downloaderFails = true
    builderInstance = 'builder-2'
    const stale = await request(app, { path: '/_ops/api/v1/snapshot', headers })
    expect(stale.json.services.downloader).to.nested.include({
      freshness: 'stale',
      ageMs: 1000,
      'snapshot.instanceId': 'downloader-1',
      'error.code': 'SERVICE_UNAVAILABLE',
      'error.message': 'Service snapshot unavailable'
    })
    expect(stale.json.services.builder).to.nested.include({ freshness: 'fresh', 'snapshot.instanceId': 'builder-2' })
    expect(JSON.stringify(stale.json)).not.to.include('secret').and.not.to.include('/path')

    now += LIMITS.staleMs
    const unknown = await request(app, { path: '/_ops/api/v1/snapshot', headers })
    expect(unknown.json.services.downloader).to.include({ freshness: 'unknown', snapshot: null, ageMs: null })
    expect(unknown.json.services.downloader.lastSuccessAt).to.equal(fresh.json.services.downloader.lastSuccessAt)
  })

  it('applies concurrent independent 1.5-second deadlines without retries', async () => {
    const token = randomBytes(32).toString('base64url')
    const observedAt = new Date().toISOString()
    const calls = { router: 0, downloader: 0, builder: 0 }
    const never = () => new Promise(() => {})
    const app = opsApp({
      env: enabled(token),
      log: () => {},
      routerService: { snapshot: () => { calls.router++; return serviceSnapshot('router', observedAt) } },
      downloader: { json: () => { calls.downloader++; return never() } },
      builder: { json: () => { calls.builder++; return never() } }
    })
    const authenticated = await login(app, token)
    const startedAt = Date.now()
    const snapshot = await request(app, { path: '/_ops/api/v1/snapshot', headers: { Cookie: cookiePair(authenticated) } })
    const duration = Date.now() - startedAt

    expect(duration).to.be.at.least(1400).and.below(2500)
    expect(calls).to.deep.equal({ router: 1, downloader: 1, builder: 1 })
    expect(snapshot.json.services.router.freshness).to.equal('fresh')
    for (const service of ['downloader', 'builder']) {
      expect(snapshot.json.services[service]).to.nested.include({ freshness: 'unknown', snapshot: null, 'error.code': 'SERVICE_TIMEOUT' })
    }
  })

  it('enforces the per-session snapshot rate limit without dispatching excess calls', async () => {
    const token = randomBytes(32).toString('base64url')
    const observedAt = new Date().toISOString()
    let calls = 0
    const app = opsApp({
      env: enabled(token),
      log: () => {},
      routerService: { snapshot: () => serviceSnapshot('router', observedAt) },
      downloader: { json: () => { calls++; return serviceSnapshot('downloader', observedAt) } },
      builder: { json: () => serviceSnapshot('builder', observedAt) }
    })
    const authenticated = await login(app, token)
    const headers = { Cookie: cookiePair(authenticated) }
    for (let index = 0; index < 12; index++) expect((await request(app, { path: '/_ops/api/v1/snapshot', headers })).status).to.equal(200)
    const limited = await request(app, { path: '/_ops/api/v1/snapshot', headers })
    expect(limited).to.nested.include({ status: 429, 'json.error.code': 'RATE_LIMITED' })
    expect(limited.headers['retry-after']).to.equal('60')
    expect(calls).to.equal(12)
  })

  it('authenticates and concurrently dispatches exact cache commands with one correlation ID and audit event', async () => {
    const token = randomBytes(32).toString('base64url')
    const secret = 'must-not-appear'
    const events = []
    const started = new Set()
    const calls = []
    const service = (name, target) => ({
      json: async (path, options) => {
        started.add(name)
        calls.push({ name, path, options })
        await new Promise(resolve => setImmediate(resolve))
        expect([...started]).to.have.members(['downloader', 'builder'])
        return cacheOperationResponse(name, options, target)
      }
    })
    const app = opsApp({
      env: enabled(token),
      log: event => events.push(event),
      downloader: service('downloader', { outcome: 'completed', removedEntries: 1, freedBytes: 42 }),
      builder: service('builder', { absent: true })
    })
    const authenticated = await login(app, token)
    const response = await request(app, {
      method: 'POST',
      path: '/_ops/api/v1/cache-operations',
      headers: {
        Cookie: cookiePair(authenticated),
        Origin: origin,
        'Content-Type': 'application/json',
        'X-Ops-CSRF': authenticated.json.csrfToken,
        Forwarded: 'for=203.0.113.9;proto=https',
        'X-Forwarded-For': '198.51.100.8',
        'X-Forwarded-Proto': 'https',
        'User-Agent': `Mozilla/5.0 ${secret} Chrome/126.0 Safari/537.36`
      },
      body: JSON.stringify({ operation: 'cache.evict_commit', targets: ['downloader', 'builder'], commit: 'a'.repeat(40) })
    })

    expect(response.status).to.equal(200)
    expect(response.json).to.include({ correlationId: response.headers['x-correlation-id'], operation: 'cache.evict_commit', outcome: 'completed' })
    expect(response.json.targets.map(target => target.outcome)).to.deep.equal(['completed', 'no_op'])
    expect(calls).to.have.length(2)
    for (const call of calls) {
      expect(call.path).to.equal('/v1/ops/cache-operations')
      expect(call.options).to.include({
        method: 'POST',
        correlationId: response.json.correlationId,
        maxRequestBytes: 4096,
        maxResponseBytes: 64 * 1024,
        timeout: 10000,
        timeoutThroughBody: true
      })
      expect(call.options.body).to.deep.equal({ operation: 'cache.evict_commit', targets: [call.name], commit: 'a'.repeat(40) })
    }

    const audits = events.filter(event => event.action === 'cache_operation')
    expect(audits).to.have.length(1)
    expect(audits[0]).to.include({
      correlationId: response.json.correlationId,
      source: null,
      userAgent: 'chromium',
      operation: 'cache.evict_commit',
      commit: 'a'.repeat(40),
      dispatchStatus: 'dispatched',
      outcome: 'completed'
    })
    expect(audits[0].sessionAuditId).to.match(/^[A-Za-z0-9_-]{22}$/)
    expect(audits[0].targets).to.deep.equal(['downloader', 'builder'])
    expect(audits[0].targetOutcomes).to.have.length(2)
    expect(JSON.stringify(audits[0])).not.to.include(token).and.not.to.include(authenticated.json.csrfToken).and.not.to.include(secret)
  })

  it('rejects unsafe cache attempts before dispatch and emits one bounded sanitized audit', async () => {
    const token = randomBytes(32).toString('base64url')
    const events = []
    let calls = 0
    const client = { json: () => { calls++; throw new Error('must not dispatch') } }
    const app = opsApp({ env: enabled(token), log: event => events.push(event), downloader: client, builder: client })
    const authenticated = await login(app, token)
    const headers = {
      Cookie: cookiePair(authenticated),
      Origin: origin,
      'Content-Type': 'application/json',
      'X-Ops-CSRF': authenticated.json.csrfToken
    }
    const rejected = await request(app, {
      method: 'POST',
      path: '/_ops/api/v1/cache-operations',
      headers,
      body: JSON.stringify({ operation: 'cache.evict_commit', targets: ['downloader'], commit: 'A'.repeat(40) })
    })

    expect(rejected).to.nested.include({ status: 400, 'json.error.code': 'INVALID_REQUEST' })
    expect(calls).to.equal(0)
    const audits = events.filter(event => event.action === 'cache_operation')
    expect(audits).to.have.length(1)
    expect(audits[0]).to.include({ userAgent: null, operation: null, dispatchStatus: 'not_dispatched', outcome: 'failed' })
    expect(audits[0].errorCodes).to.deep.equal(['INVALID_REQUEST'])

    for (const missing of [
      { Origin: origin, 'Content-Type': 'application/json', 'X-Ops-CSRF': authenticated.json.csrfToken },
      { Cookie: cookiePair(authenticated), Origin: origin, 'Content-Type': 'application/json', 'X-Ops-CSRF': 'wrong' },
      { Cookie: cookiePair(authenticated), Origin: origin, 'X-Ops-CSRF': authenticated.json.csrfToken }
    ]) {
      const response = await request(app, { method: 'POST', path: '/_ops/api/v1/cache-operations', headers: missing, body: '{}' })
      expect(response.status).to.be.oneOf([401, 403, 415])
    }
    expect(events.filter(event => event.action === 'cache_operation')).to.have.length(4)
  })

  it('finalizes one cache audit with settled target outcomes after the client closes', async () => {
    const token = randomBytes(32).toString('base64url')
    const events = []
    const releases = {}
    let resolveDispatched
    let resolveResponseClosed
    let resolveAudited
    const dispatched = new Promise(resolve => { resolveDispatched = resolve })
    const responseClosed = new Promise(resolve => { resolveResponseClosed = resolve })
    const audited = new Promise(resolve => { resolveAudited = resolve })
    const service = (name, target) => ({
      json: (path, options) => new Promise(resolve => {
        releases[name] = () => resolve(cacheOperationResponse(name, options, target))
        if (Object.keys(releases).length === 2) resolveDispatched()
      })
    })
    const ops = {
      env: enabled(token),
      log: event => {
        events.push(event)
        if (event.action === 'cache_operation') resolveAudited()
      },
      downloader: service('downloader', { outcome: 'completed', removedEntries: 1, freedBytes: 42 }),
      builder: service('builder', { absent: true })
    }
    const app = express()
    app.use((request, response, next) => {
      if (request.method === 'POST' && request.path === '/_ops/api/v1/cache-operations') response.once('close', resolveResponseClosed)
      next()
    })
    app.use('/_ops', createOpsConsoleRouter(ops))
    const authenticated = await login(app, token)
    const server = app.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    const outgoing = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method: 'POST',
      path: '/_ops/api/v1/cache-operations',
      headers: {
        Cookie: cookiePair(authenticated),
        Origin: origin,
        'Content-Type': 'application/json',
        'X-Ops-CSRF': authenticated.json.csrfToken
      }
    })
    outgoing.on('error', () => {})
    outgoing.end(JSON.stringify({ operation: 'cache.evict_commit', targets: ['downloader', 'builder'], commit: 'a'.repeat(40) }))

    await dispatched
    outgoing.destroy()
    await responseClosed
    expect(events.filter(event => event.action === 'cache_operation')).to.have.length(0)

    releases.downloader()
    releases.builder()
    await audited
    await new Promise(resolve => server.close(resolve))

    const audits = events.filter(event => event.action === 'cache_operation')
    expect(audits).to.have.length(1)
    expect(audits[0]).to.include({ dispatchStatus: 'dispatched', outcome: 'completed' })
    expect(audits[0].targetOutcomes).to.deep.equal([
      { service: 'downloader', outcome: 'completed', removedEntries: 1, freedBytes: 42, absent: false, skippedInUse: 0, skippedChanged: 0 },
      { service: 'builder', outcome: 'no_op', removedEntries: 0, freedBytes: 0, absent: true, skippedInUse: 0, skippedChanged: 0 }
    ])
  })

  it('enforces the cache-operation session rate before dispatch', async () => {
    const token = randomBytes(32).toString('base64url')
    let calls = 0
    const client = { json: (path, options) => { calls++; return cacheOperationResponse('builder', options) } }
    const app = opsApp({ env: enabled(token), log: () => {}, downloader: client, builder: client })
    const authenticated = await login(app, token)
    const options = {
      method: 'POST',
      path: '/_ops/api/v1/cache-operations',
      headers: { Cookie: cookiePair(authenticated), Origin: origin, 'Content-Type': 'application/json', 'X-Ops-CSRF': authenticated.json.csrfToken },
      body: JSON.stringify({ operation: 'cache.clear', targets: ['builder'] })
    }
    for (let index = 0; index < 5; index++) expect((await request(app, options)).status).to.equal(200)
    const limited = await request(app, options)
    expect(limited).to.nested.include({ status: 429, 'json.error.code': 'RATE_LIMITED' })
    expect(limited.headers['retry-after']).to.equal('60')
    expect(calls).to.equal(5)
  })

  it('returns unknown without retrying when a dispatched target is ambiguous', async () => {
    const token = randomBytes(32).toString('base64url')
    const events = []
    let calls = 0
    const app = opsApp({
      env: enabled(token),
      log: event => events.push(event),
      downloader: { json: () => { calls++; return Promise.reject(Object.assign(new Error('secret /path'), { code: 'SERVICE_TIMEOUT' })) } },
      builder: { json: () => { throw new Error('not targeted') } }
    })
    const authenticated = await login(app, token)
    const response = await request(app, {
      method: 'POST',
      path: '/_ops/api/v1/cache-operations',
      headers: { Cookie: cookiePair(authenticated), Origin: origin, 'Content-Type': 'application/json', 'X-Ops-CSRF': authenticated.json.csrfToken },
      body: JSON.stringify({ operation: 'cache.evict_commit', targets: ['downloader'], commit: 'a'.repeat(40) })
    })

    expect(response).to.nested.include({ status: 200, 'json.outcome': 'unknown', 'json.targets.0.outcome': 'unknown', 'json.targets.0.error.code': 'SERVICE_TIMEOUT' })
    expect(calls).to.equal(1)
    const audit = events.find(event => event.action === 'cache_operation')
    expect(audit).to.include({ dispatchStatus: 'dispatched', outcome: 'unknown' })
    expect(audit.errorCodes).to.deep.equal(['SERVICE_TIMEOUT'])
    expect(JSON.stringify(response.json) + JSON.stringify(audit)).not.to.include('secret').and.not.to.include('/path')
  })

  it('keeps future APIs reserved and returns uniform bounded errors with security headers', async () => {
    const token = randomBytes(32).toString('base64url')
    const app = opsApp({ env: enabled(token), log: () => {} })
    for (const path of ['/_ops/api/v1/cache-operations', '/_ops/api/v1/unknown']) {
      const response = await request(app, { path })
      expect(response).to.nested.include({ status: 404, 'json.error.code': 'NOT_FOUND' })
      expect(response.json.error.correlationId).to.equal(response.headers['x-correlation-id'])
      expectSecurityHeaders(response.headers)
      expect(response.headers).not.to.have.property('access-control-allow-origin')
    }
  })
})

function serviceSnapshot (service, observedAt, overrides = {}) {
  const capabilityNames = {
    router: ['public_file_delivery', 'console_read', 'console_cache_control'],
    downloader: ['ref_resolution', 'source_file_delivery', 'source_archive_delivery', 'cache_control'],
    builder: ['build_delivery', 'cache_control']
  }
  return {
    schemaVersion: 1,
    service,
    instanceId: overrides.instanceId || `${service}-1`,
    startedAt: observedAt,
    observedAt,
    health: { status: 'healthy', reasons: [] },
    capabilities: capabilityNames[service].map(name => ({ name, status: 'available', reasonCode: null })),
    queues: [],
    cache: null,
    dependencies: [],
    telemetry: { activityDropped: 0, completedEvicted: 0, failuresEvicted: 0, spansDropped: 0 },
    activity: overrides.activity || [],
    failures: overrides.failures || []
  }
}

function activity (correlationId, service, operation) {
  const time = '2026-07-20T12:00:00.000Z'
  return {
    correlationId,
    state: 'completed',
    startedAt: time,
    completedAt: time,
    durationMs: 0,
    request: { method: 'GET', route: '/:ref/*', commit: null, resource: null, buildMode: null },
    outcome: { status: 'succeeded', httpStatus: 200, code: null },
    spans: [{ service, operation, state: 'completed', startedAt: time, completedAt: time, durationMs: 0, outcome: { status: 'succeeded', httpStatus: 200, code: null } }]
  }
}

function failure (correlationId, service, operation) {
  return { occurredAt: '2026-07-20T12:00:00.000Z', correlationId, service, operation, code: 'INTERNAL_ERROR', summary: 'An internal error occurred', httpStatus: 500, commit: null }
}

function cacheOperationResponse (service, options, overrides = {}) {
  const operation = options.body.operation
  const target = {
    service,
    outcome: 'no_op',
    removedEntries: 0,
    freedBytes: 0,
    absent: false,
    skippedInUse: 0,
    error: null,
    ...overrides
  }
  if (operation !== 'cache.clear') target.skippedChanged = 0
  return {
    correlationId: options.correlationId,
    operation,
    startedAt: '2026-07-20T12:00:00.000Z',
    completedAt: '2026-07-20T12:00:00.000Z',
    outcome: target.outcome,
    targets: [target]
  }
}

function opsApp (ops) {
  return createApp({ ops, router: express.Router().use((request, response) => response.sendStatus(418)) })
}

function login (app, token, cookie, extraHeaders = {}) {
  const headers = { Origin: 'http://127.0.0.1:8080', 'Content-Type': 'application/json', ...extraHeaders }
  if (cookie) headers.Cookie = cookie
  return request(app, { method: 'POST', path: '/_ops/api/v1/session', headers, body: JSON.stringify({ token }) })
}

function cookiePair (response) {
  return response.headers['set-cookie'][0].split(';', 1)[0]
}

function expectSecurityHeaders (headers) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(headers[name.toLowerCase()]).to.equal(value)
}

function request (app, { method = 'GET', path, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const outgoing = http.request({ host: '127.0.0.1', port: server.address().port, method, path, headers }, response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          server.close()
          const responseBody = Buffer.concat(chunks).toString()
          let json
          try { json = JSON.parse(responseBody) } catch (error) {}
          resolve({ status: response.statusCode, headers: response.headers, body: responseBody, json })
        })
      })
      outgoing.on('error', error => server.close(() => reject(error)))
      if (body) outgoing.write(body)
      outgoing.end()
    })
  })
}
