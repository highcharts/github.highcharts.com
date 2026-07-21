'use strict'

const { expect } = require('chai')
const { randomBytes } = require('node:crypto')
const { Readable } = require('node:stream')
const { describe, it } = require('mocha')
const {
  MAX_BODY_BYTES,
  OpsHttpError,
  SECURITY_HEADERS,
  errorBody,
  getTrustedRequestContext,
  readStrictJSON,
  requireBearer,
  requireCSRF,
  requireJSONContentType,
  requireOrigin,
  requireSameOriginFetch,
  setSecurityHeaders,
  strictJSON
} = require('../app/ops/http')
const {
  deriveCacheOutcome,
  validateCacheOperationRequest,
  validateCacheOperationResponse,
  validateLoginRequest,
  validateServiceSnapshot
} = require('../app/ops/schemas')
const {
  ABSOLUTE_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  OpsRateLimiter,
  SESSION_CAPACITY,
  SessionStore,
  createAuditId,
  sessionResponse
} = require('../app/ops/sessions')

describe('operations console HTTP boundaries', () => {
  it('parses one bounded UTF-8 object and rejects duplicate or ambiguous JSON', async () => {
    expect(strictJSON('{"name":"ok","nested":{"x":1}}')).to.deep.equal({ name: 'ok', nested: { x: 1 } })
    expect(await readStrictJSON(Readable.from(['{"ok":', 'true}']))).to.deep.equal({ ok: true })
    const bounded = `{"value":"${'x'.repeat(MAX_BODY_BYTES - 12)}"}`
    expect(Buffer.byteLength(bounded)).to.equal(MAX_BODY_BYTES)
    expect(strictJSON(bounded).value).to.have.length(MAX_BODY_BYTES - 12)
    for (const input of [
      '{"x":1,"x":2}',
      '{"x":1,"\\u0078":2}',
      '[]',
      'null',
      '{"x":NaN}',
      '{"x":1} trailing',
      '{\u00a0"x":1}',
      Buffer.from([0xc3, 0x28])
    ]) expect(() => strictJSON(input)).to.throw(OpsHttpError).with.property('code', 'INVALID_JSON')
    expect(() => strictJSON(Buffer.alloc(MAX_BODY_BYTES + 1))).to.throw(OpsHttpError).with.property('status', 413)
  })

  it('sets every required security header exactly and no CORS or HSTS header', () => {
    const headers = {}
    setSecurityHeaders({ setHeader: (name, value) => { headers[name] = value } })
    expect(headers).to.deep.equal(SECURITY_HEADERS)
    expect(headers).not.to.have.keys('Access-Control-Allow-Origin', 'Strict-Transport-Security')
  })

  it('enforces exact Origin, Fetch Metadata, JSON media type, CSRF, and bearer credentials', () => {
    const request = {
      headers: {
        origin: 'https://ops.example.test',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json; charset=utf-8',
        'x-ops-csrf': 'csrf',
        authorization: 'Bearer internal-token'
      }
    }
    expect(() => requireOrigin(request, 'https://ops.example.test')).not.to.throw()
    expect(() => requireSameOriginFetch(request)).not.to.throw()
    expect(() => requireJSONContentType(request)).not.to.throw()
    expect(() => requireCSRF(request, 'csrf')).not.to.throw()
    expect(() => requireBearer(request, 'internal-token')).not.to.throw()

    for (const guard of [
      () => requireOrigin({ headers: {} }, 'https://ops.example.test'),
      () => requireOrigin({ headers: { origin: 'https://OPS.example.test' } }, 'https://ops.example.test'),
      () => requireSameOriginFetch({ headers: { 'sec-fetch-site': 'cross-site' } }),
      () => requireJSONContentType({ headers: { 'content-type': 'application/json; charset=latin1' } }),
      () => requireCSRF({ headers: { 'x-ops-csrf': 'wrong' } }, 'csrf'),
      () => requireBearer({ headers: { authorization: 'Bearer wrong' } }, 'internal-token')
    ]) expect(guard).to.throw(OpsHttpError)
  })

  it('allows Fetch Metadata none only for an explicitly permitted passive document navigation', () => {
    const navigation = {
      method: 'GET',
      headers: {
        'sec-fetch-site': 'none',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document'
      }
    }
    expect(() => requireSameOriginFetch({ headers: {} })).not.to.throw()
    expect(() => requireSameOriginFetch({ headers: { 'sec-fetch-site': 'same-origin' } })).not.to.throw()
    expect(() => requireSameOriginFetch(navigation, { allowTopLevelNavigation: true })).not.to.throw()

    for (const request of [
      navigation,
      { ...navigation, method: 'POST' },
      { ...navigation, headers: { ...navigation.headers, 'sec-fetch-mode': 'cors' } },
      { ...navigation, headers: { ...navigation.headers, 'sec-fetch-mode': '' } },
      { ...navigation, headers: { ...navigation.headers, 'sec-fetch-mode': ['navigate'] } },
      { ...navigation, headers: { ...navigation.headers, 'sec-fetch-mode': undefined } },
      { ...navigation, headers: { ...navigation.headers, 'sec-fetch-dest': 'script' } },
      { ...navigation, headers: { ...navigation.headers, 'sec-fetch-dest': '' } },
      { ...navigation, headers: { ...navigation.headers, 'sec-fetch-dest': ['document'] } },
      { ...navigation, headers: { ...navigation.headers, 'sec-fetch-dest': undefined } },
      { ...navigation, headers: { ...navigation.headers, 'sec-fetch-site': 'cross-site' } }
    ]) {
      expect(() => requireSameOriginFetch(request)).to.throw(OpsHttpError).that.includes({
        status: 403,
        code: 'FETCH_METADATA_REJECTED'
      })
    }
  })

  it('fails closed for absent, empty, or non-string CSRF and bearer credentials', () => {
    for (const headers of [
      {},
      { 'x-ops-csrf': '' },
      { 'x-ops-csrf': ['csrf'] }
    ]) {
      expect(() => requireCSRF({ headers }, 'csrf')).to.throw(OpsHttpError).that.includes({ status: 403, code: 'CSRF_REJECTED' })
    }
    for (const headers of [
      {},
      { authorization: '' },
      { authorization: ['Bearer internal-token'] },
      { authorization: 'Bearer ' }
    ]) {
      expect(() => requireBearer({ headers }, 'internal-token')).to.throw(OpsHttpError).that.includes({ status: 401, code: 'UNAUTHORIZED' })
    }
    for (const expected of [undefined, '', null, 1]) {
      expect(() => requireCSRF({ headers: { 'x-ops-csrf': '' } }, expected)).to.throw('Invalid expected credential')
      expect(() => requireBearer({ headers: {} }, expected)).to.throw('Invalid expected credential')
    }
  })

  it('requires an authorized encrypted socket for HTTPS and ignores forwarded claims', () => {
    const context = getTrustedRequestContext({
      socket: { remoteAddress: '10.2.3.4', encrypted: true, authorized: true },
      headers: {
        forwarded: 'for=192.0.2.8;proto=http',
        'x-forwarded-for': '192.0.2.8',
        'x-forwarded-proto': 'http'
      }
    }, { protocol: 'https' })
    expect(context).to.deep.equal({ protocol: 'https', source: null })

    for (const socket of [
      { encrypted: false, authorized: true },
      { encrypted: true, authorized: false },
      { encrypted: true },
      {}
    ]) expect(() => getTrustedRequestContext({ socket, headers: {} }, { protocol: 'https' })).to.throw(OpsHttpError)
  })

  it('requires direct HTTP request sources to be loopback', () => {
    const config = { protocol: 'http' }
    expect(getTrustedRequestContext({ socket: { remoteAddress: '::1' }, headers: { 'x-forwarded-for': '192.0.2.1' } }, config).source).to.equal('::1')
    expect(() => getTrustedRequestContext({ socket: { remoteAddress: '192.0.2.1' }, headers: {} }, config)).to.throw(OpsHttpError)
    expect(() => getTrustedRequestContext({ socket: { remoteAddress: '127.0.0.1', encrypted: true }, headers: {} }, config)).to.throw(OpsHttpError)
  })

  it('produces bounded generic errors without reflecting sensitive values', () => {
    const secret = randomBytes(32).toString('base64url')
    const internal = errorBody(new Error(`failed for ${secret}`), 'correlation-id')
    expect(internal).to.deep.equal({ status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred', correlationId: 'correlation-id' } } })
    expect(JSON.stringify(internal)).not.to.include(secret)

    const safe = errorBody(new OpsHttpError(400, 'INVALID_REQUEST', 'Request body is invalid', ['token', 'token', secret.repeat(2)]), 'id')
    expect(safe.body.error.details.fields).to.deep.equal(['token'])
  })
})

describe('operations console schemas', () => {
  const time = '2026-07-17T12:00:00.000Z'

  it('keeps malformed login attempts generic and accepts only an exact canonical token object', () => {
    const token = randomBytes(32).toString('base64url')
    expect(validateLoginRequest({ token })).to.deep.equal({ token })
    for (const body of [
      undefined,
      null,
      [],
      'token',
      {},
      { token, extra: true },
      { token: undefined },
      { token: null },
      { token: '' },
      { token: 'not-valid' },
      { token: 'x'.repeat(513) }
    ]) {
      expect(() => validateLoginRequest(body)).to.throw(OpsHttpError).that.includes({
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication failed',
        fields: undefined
      })
    }
    let loginError
    try { validateLoginRequest({ token, extra: true }) } catch (error) { loginError = error }
    const failure = errorBody(loginError, 'login-failure')
    expect(failure).to.deep.equal({
      status: 401,
      body: { error: { code: 'UNAUTHORIZED', message: 'Authentication failed', correlationId: 'login-failure' } }
    })
    expect(JSON.stringify(failure)).not.to.include(token)
  })

  it('strictly validates named cache requests', () => {
    const commit = 'a'.repeat(40)
    expect(validateCacheOperationRequest({ operation: 'cache.evict_commit', targets: ['downloader', 'builder'], commit })).to.deep.equal({ operation: 'cache.evict_commit', targets: ['downloader', 'builder'], commit })
    expect(validateCacheOperationRequest({ operation: 'cache.clear', targets: ['builder'] })).to.deep.equal({ operation: 'cache.clear', targets: ['builder'] })
    for (const body of [
      { operation: 'cache.clear', targets: ['builder'], commit },
      { operation: 'cache.purge_expired', targets: ['builder', 'downloader'] },
      { operation: 'cache.evict_commit', targets: ['builder'], commit: commit.toUpperCase() },
      { operation: 'cache.clear', targets: ['builder', 'builder'] },
      { operation: 'cleanup', targets: ['builder'] }
    ]) expect(() => validateCacheOperationRequest(body)).to.throw(OpsHttpError)
  })

  it('derives and validates cache outcomes without treating absent as partial', () => {
    const target = (service, outcome, values = {}) => ({
      service,
      outcome,
      removedEntries: 0,
      freedBytes: 0,
      absent: false,
      skippedInUse: 0,
      skippedChanged: 0,
      error: null,
      ...values
    })
    expect(deriveCacheOutcome([target('builder', 'completed', { removedEntries: 1 }), target('downloader', 'no_op', { absent: true })])).to.equal('completed')
    expect(deriveCacheOutcome([target('builder', 'partial', { removedEntries: 1, skippedInUse: 1 })])).to.equal('partial')
    expect(deriveCacheOutcome([target('builder', 'unknown')])).to.equal('unknown')

    const response = {
      correlationId: 'correlation-id',
      operation: 'cache.evict_commit',
      startedAt: time,
      completedAt: time,
      outcome: 'completed',
      targets: [target('builder', 'completed', { removedEntries: 1 })],
      ignoredAdditiveField: true
    }
    expect(validateCacheOperationResponse(response).outcome).to.equal('completed')
    expect(() => validateCacheOperationResponse({ ...response, outcome: 'partial' })).to.throw()
  })

  it('accepts additive internal fields but rejects missing, incompatible, and unbounded snapshots', () => {
    const snapshot = {
      schemaVersion: 1,
      service: 'builder',
      instanceId: 'instance-id',
      startedAt: time,
      observedAt: time,
      health: { status: 'healthy', reasons: [] },
      capabilities: [{ name: 'build_delivery', status: 'available', reasonCode: null }],
      queues: [{ name: 'build', active: 1, queued: 1, limit: 4, available: 2, oldestQueuedAgeMs: 10 }],
      cache: null,
      dependencies: [],
      telemetry: { activityDropped: 0, completedEvicted: 0, failuresEvicted: 0, spansDropped: 0 },
      futureField: true
    }
    expect(validateServiceSnapshot(snapshot, 'builder')).to.include({ schemaVersion: 1, service: 'builder' })
    for (const invalid of [
      { ...snapshot, schemaVersion: 2 },
      { ...snapshot, service: 'downloader' },
      { ...snapshot, queues: [{ ...snapshot.queues[0], available: 3 }] },
      { ...snapshot, capabilities: Array(17).fill(snapshot.capabilities[0]) },
      { ...snapshot, health: { status: 'degraded', reasons: [] } },
      { ...snapshot, activity: [{ correlationId: 'id', state: 'active' }] },
      { ...snapshot, instanceId: 'x'.repeat(65) },
      { ...snapshot, observedAt: 'not-a-time' }
    ]) expect(() => validateServiceSnapshot(invalid, 'builder')).to.throw().with.property('code', 'INCOMPATIBLE_SCHEMA')
  })
})

describe('operations console sessions', () => {
  const start = Date.parse('2026-07-17T12:00:00.000Z')

  it('creates opaque server-side sessions with bounded public state and audit IDs', () => {
    const store = new SessionStore({ now: () => start })
    const created = store.create()
    const response = sessionResponse(created.session)

    expect(created.sessionId).to.match(/^[A-Za-z0-9_-]{43}$/)
    expect(created.session.csrfToken).to.match(/^[A-Za-z0-9_-]{43}$/)
    expect(created.session.auditId).to.match(/^[A-Za-z0-9_-]{22}$/)
    expect(new Set([created.sessionId, created.session.csrfToken, created.session.auditId]).size).to.equal(3)
    expect(response).to.deep.equal({
      authenticated: true,
      idleExpiresAt: new Date(start + IDLE_TIMEOUT_MS).toISOString(),
      absoluteExpiresAt: new Date(start + ABSOLUTE_TIMEOUT_MS).toISOString(),
      csrfToken: created.session.csrfToken
    })
    expect(response).not.to.have.keys('sessionId', 'auditId', 'generation')
    expect(createAuditId()).to.match(/^[A-Za-z0-9_-]{22}$/)
  })

  it('renews idle lifetime exactly but never extends absolute lifetime', () => {
    let now = start
    const store = new SessionStore({ now: () => now })
    const { sessionId } = store.create()

    for (now = start + IDLE_TIMEOUT_MS - 1; now < start + ABSOLUTE_TIMEOUT_MS; now += IDLE_TIMEOUT_MS - 1) {
      expect(store.authenticate(sessionId)).not.to.equal(null)
    }
    now = start + ABSOLUTE_TIMEOUT_MS - 1
    expect(store.authenticate(sessionId, { renew: false })).not.to.equal(null)
    now++
    expect(store.authenticate(sessionId)).to.equal(null)
    expect(store.size).to.equal(0)
  })

  it('rejects at the exact idle boundary and pruning cannot revive expiry', () => {
    let now = start
    const store = new SessionStore({ now: () => now })
    const { sessionId } = store.create()
    now += IDLE_TIMEOUT_MS

    expect(store.pruneExpired()).to.equal(1)
    now = start
    expect(store.authenticate(sessionId)).to.equal(null)
  })

  it('rotates replacement logins, logout revocation, and verifier generations', () => {
    const store = new SessionStore({ now: () => start, generation: 4 })
    const first = store.create()
    const replacement = store.create(first.sessionId)
    expect(replacement.sessionId).not.to.equal(first.sessionId)
    expect(store.authenticate(first.sessionId)).to.equal(null)
    expect(store.authenticate(replacement.sessionId)).not.to.equal(null)
    expect(store.revoke(replacement.sessionId)).to.equal(true)
    expect(store.revoke(replacement.sessionId)).to.equal(false)

    const rotated = store.create()
    expect(store.rotate(5)).to.equal(1)
    expect(store.authenticate(rotated.sessionId)).to.equal(null)
    expect(store.rotate(5)).to.equal(0)
  })

  it('has hard fail-closed capacity without evicting live sessions', () => {
    const store = new SessionStore({ now: () => start })
    const ids = Array.from({ length: SESSION_CAPACITY }, () => store.create().sessionId)
    expect(() => store.create()).to.throw(OpsHttpError).that.includes({ status: 503, code: 'SESSION_CAPACITY' })
    expect(store.size).to.equal(SESSION_CAPACITY)
    expect(ids.every(id => store.authenticate(id, { renew: false }))).to.equal(true)

    const replacement = store.create(ids[0])
    expect(store.size).to.equal(SESSION_CAPACITY)
    expect(store.authenticate(ids[0])).to.equal(null)
    expect(store.authenticate(replacement.sessionId)).not.to.equal(null)
  })

  it('uses Phase 1.1 CSRF guards and never leaks session secrets in failures', () => {
    const store = new SessionStore({ now: () => start })
    const { sessionId, session } = store.create()
    const request = { headers: { 'x-ops-csrf': session.csrfToken } }
    expect(() => requireCSRF(request, session.csrfToken)).not.to.throw()
    expect(() => requireCSRF({ headers: {} }, session.csrfToken)).to.throw(OpsHttpError)

    const failure = errorBody(new OpsHttpError(503, 'SESSION_CAPACITY', 'Session capacity is unavailable'), 'audit-safe')
    expect(JSON.stringify(failure)).not.to.include(sessionId)
    expect(JSON.stringify(failure)).not.to.include(session.csrfToken)
    expect(JSON.stringify(failure)).not.to.include(session.auditId)
    expect(store.authenticate(`missing-${sessionId}`)).to.equal(null)
  })
})

describe('operations console rate limits', () => {
  const start = Date.parse('2026-07-17T12:00:00.000Z')

  it('enforces only the process-wide 30-attempt login limit for 15 minutes', () => {
    let now = start
    const limiter = new OpsRateLimiter({ now: () => now })
    for (let index = 0; index < 30; index++) expect(limiter.attemptLogin()).to.include({ allowed: true, remaining: 29 - index })
    expect(limiter.attemptLogin()).to.include({ allowed: false, retryAfter: 900 })
    now += 15 * 60 * 1000 - 1
    expect(limiter.attemptLogin()).to.include({ allowed: false, retryAfter: 1 })
    now++
    expect(limiter.attemptLogin()).to.include({ allowed: true, remaining: 29 })
  })

  it('enforces snapshot, per-session cache, and global cache limits', () => {
    let now = start
    const limiter = new OpsRateLimiter({ now: () => now })
    for (let index = 0; index < 12; index++) expect(limiter.attemptSnapshot('session-a').allowed).to.equal(true)
    expect(limiter.attemptSnapshot('session-a')).to.include({ allowed: false, retryAfter: 60 })

    for (let index = 0; index < 5; index++) expect(limiter.attemptCacheOperation('session-a').allowed).to.equal(true)
    expect(limiter.attemptCacheOperation('session-a')).to.include({ allowed: false, retryAfter: 60 })
    for (let index = 0; index < 14; index++) expect(limiter.attemptCacheOperation(`session-${index + 1}`).allowed).to.equal(true)
    expect(limiter.attemptCacheOperation('session-global')).to.include({ allowed: false, retryAfter: 60 })

    now += 60 * 1000
    expect(limiter.attemptSnapshot('session-a')).to.include({ allowed: true, remaining: 11 })
    expect(limiter.attemptCacheOperation('session-a')).to.include({ allowed: true, remaining: 4 })
  })

  it('cleans session buckets and bounds their storage without eviction', () => {
    let now = start
    const limiter = new OpsRateLimiter({ now: () => now })
    limiter.attemptSnapshot('session')
    limiter.attemptCacheOperation('session')
    limiter.removeSession('session')
    expect(limiter.bucketCounts).to.deep.equal({ snapshotSessions: 0, cacheSessions: 0 })

    for (let index = 0; index < SESSION_CAPACITY; index++) {
      limiter.attemptSnapshot(`snapshot-${index}`)
      limiter.attemptCacheOperation(`cache-${index}`)
    }
    expect(limiter.attemptSnapshot('snapshot-overflow').allowed).to.equal(false)
    expect(limiter.attemptCacheOperation('cache-overflow').allowed).to.equal(false)
    expect(limiter.bucketCounts).to.deep.equal({
      snapshotSessions: SESSION_CAPACITY,
      cacheSessions: SESSION_CAPACITY
    })

    now += 15 * 60 * 1000
    limiter.prune()
    expect(limiter.bucketCounts).to.deep.equal({ snapshotSessions: 0, cacheSessions: 0 })
  })

  it('returns generic rate results without retaining or exposing keys', () => {
    const limiter = new OpsRateLimiter({ now: () => start })
    const secret = randomBytes(32).toString('base64url')
    const result = limiter.attemptSnapshot(secret)
    expect(result).to.deep.equal({ allowed: true, remaining: 11, retryAfter: 0, resetAt: start + 60000 })
    expect(JSON.stringify(result)).not.to.include(secret)
    expect(JSON.stringify(limiter.bucketCounts)).not.to.include(secret)
  })
})
