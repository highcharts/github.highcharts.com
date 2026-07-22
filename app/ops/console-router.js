'use strict'

const { randomUUID } = require('node:crypto')
const path = require('node:path')
const express = require('express')
const appConfig = require('../../config.json')
const { createServiceClient } = require('../service-client')
const { parseOpsConfig, verifyToken } = require('./config')
const {
  OpsHttpError,
  asyncRoute,
  errorBody,
  readStrictJSON,
  requireCSRF,
  requireJSONContentType,
  requireOrigin,
  requireSameOriginFetch,
  setSecurityHeaders
} = require('./http')
const {
  deriveCacheOutcome,
  validateCacheOperationRequest,
  validateCacheOperationResponse,
  validateLoginRequest,
  validateServiceSnapshot
} = require('./schemas')
const { OpsRateLimiter, SessionStore, sessionResponse } = require('./sessions')
const { mergeActivity, serviceSlot } = require('./telemetry')

const COOKIE_NAMES = Object.freeze({ http: 'ghhc-console-dev', https: '__Host-hc-ops' })
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/
const SNAPSHOT_TIMEOUT_MS = 1500
const CACHE_OPERATION_TIMEOUT_MS = 10000
const MAX_SNAPSHOT_BYTES = 1024 * 1024
const MAX_CACHE_OPERATION_BYTES = 64 * 1024
const REFRESH_AFTER_MS = 30000
const SPAN_OPERATIONS = [
  'public_file_delivery',
  'github_branch_lookup',
  'github_commit_lookup',
  'github_esbuild_detection',
  'source_download',
  'file_download',
  'source_archive',
  'build'
]
const SLOT_ERROR_CODES = new Set(['INCOMPATIBLE_SCHEMA', 'SERVICE_RESPONSE_TOO_LARGE', 'SERVICE_TIMEOUT', 'SERVICE_UNAVAILABLE'])
const STATIC_DIR = path.join(__dirname, '../../static/ops')

function createOpsConsoleRouter ({ env = process.env, log = logStatus, now = Date.now, sessions, rateLimiter, downloader, builder, routerService } = {}) {
  const config = parseOpsConfig(env)
  log({ time: new Date(now()).toISOString(), action: 'operations_console_status', enabled: config.enabled })

  const router = express.Router()
  router.use((request, response, next) => {
    setSecurityHeaders(response)
    next()
  })

  if (!config.enabled) {
    router.use((request, response) => response.sendStatus(404))
    return router
  }

  const store = sessions || new SessionStore({ now })
  const limiter = rateLimiter || new OpsRateLimiter({ now })
  const token = env.INTERNAL_SERVICE_TOKEN
  downloader = downloader || createServiceClient({ baseURL: env.DOWNLOADER_URL || appConfig.downloaderURL, token, timeout: SNAPSHOT_TIMEOUT_MS })
  builder = builder || createServiceClient({ baseURL: env.BUILDER_URL || appConfig.builderURL || 'http://127.0.0.1:8082', token, timeout: SNAPSHOT_TIMEOUT_MS })
  routerService = routerService || defaultRouterService()
  const snapshotState = Object.fromEntries(['router', 'downloader', 'builder'].map(service => [service, {
    attempt: 0,
    lastAttemptAt: null,
    lastSuccess: null,
    lastSuccessAttempt: 0,
    error: null
  }]))
  const cookieName = COOKIE_NAMES[config.protocol]
  const cleanup = setInterval(() => store.pruneExpired(), 60 * 1000)
  cleanup.unref()

  router.use((request, response, next) => {
    request.correlationId = randomUUID()
    if (request.path.startsWith('/api/')) response.set('X-Correlation-ID', request.correlationId)
    if (request.method === 'POST' && request.path === '/api/v1/cache-operations') {
      request.cacheAudit = cacheAudit(request, now)
      const emit = () => {
        if (!request.cacheAudit.dispatched) emitCacheAudit(request, log, now)
      }
      response.once('finish', emit)
      response.once('close', emit)
    }
    try {
      requireSameOriginFetch(request, {
        allowTopLevelNavigation: request.path === '/' || request.path === '/login'
      })
      next()
    } catch (error) {
      next(error)
    }
  })

  router.get('/login', exactFile('/login', 'login.html'))
  for (const asset of ['console.css', 'console.js', 'login.js']) {
    router.get('/' + asset, exactFile('/' + asset, asset))
  }
  router.get('/', (request, response, next) => {
    if (request.originalUrl.split('?', 1)[0] !== '/_ops/') return next()
    const sessionId = readSessionId(request, cookieName)
    if (!store.authenticate(sessionId, { renew: false })) return response.redirect(302, '/_ops/login')
    response.sendFile(path.join(STATIC_DIR, 'index.html'))
  })

  router.post('/api/v1/session', asyncRoute(async (request, response) => {
    requireOrigin(request, config.origin)
    enforceRateLimit(limiter.attemptLogin(), response)
    requireJSONContentType(request)
    const credentials = validateLoginRequest(await readStrictJSON(request))
    if (!verifyToken(credentials.token, config.verifierDigest)) throw authenticationFailed()

    const previousSessionId = readSessionId(request, cookieName)
    const created = store.create(previousSessionId)
    response.set('Set-Cookie', sessionCookie(cookieName, created.sessionId, config.protocol))
    response.status(201).json(sessionResponse(created.session))
  }))

  router.head('/api/v1/session', (request, response) => sendNotFound(response, request.correlationId))

  router.get('/api/v1/session', (request, response, next) => {
    try {
      const { session } = authenticate(request, store, cookieName)
      response.json(sessionResponse(session))
    } catch (error) {
      next(error)
    }
  })

  router.head('/api/v1/snapshot', (request, response) => sendNotFound(response, request.correlationId))

  router.get('/api/v1/snapshot', asyncRoute(async (request, response) => {
    const { sessionId } = authenticate(request, store, cookieName)
    enforceRateLimit(limiter.attemptSnapshot(sessionId), response)
    const attempts = await Promise.all([
      attemptSnapshot('router', () => routerService.snapshot(), snapshotState, now),
      attemptSnapshot('downloader', () => downloader.json('/v1/ops/snapshot', snapshotRequest(request.correlationId)), snapshotState, now),
      attemptSnapshot('builder', () => builder.json('/v1/ops/snapshot', snapshotRequest(request.correlationId)), snapshotState, now)
    ])
    const byService = Object.fromEntries(attempts.map(attempt => [attempt.service, attempt]))
    commitAttempt(byService.downloader, snapshotState.downloader)
    commitAttempt(byService.builder, snapshotState.builder)

    const observedAt = new Date(now()).toISOString()
    const remoteSlots = {
      downloader: serviceSlot(snapshotState.downloader, observedAt),
      builder: serviceSlot(snapshotState.builder, observedAt)
    }
    if (byService.router.snapshot) {
      byService.router.snapshot = validateServiceSnapshot(deriveRouterSnapshot(byService.router.snapshot, remoteSlots), 'router')
    }
    commitAttempt(byService.router, snapshotState.router)
    const slots = {
      router: serviceSlot(snapshotState.router, observedAt),
      ...remoteSlots
    }
    const fragments = [slots.downloader.snapshot, slots.builder.snapshot].filter(Boolean).flatMap(snapshot => snapshot.activity)
    const merged = mergeActivity(slots.router.snapshot?.activity || [], fragments, SPAN_OPERATIONS)
    if (slots.router.snapshot) {
      slots.router.snapshot.telemetry.spansDropped = Math.min(Number.MAX_SAFE_INTEGER, slots.router.snapshot.telemetry.spansDropped + merged.spansDropped)
    }
    const failures = Object.values(slots).flatMap(slot => slot.snapshot?.failures || [])
      .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))

    response.json({
      schemaVersion: 1,
      correlationId: request.correlationId,
      observedAt,
      refreshAfterMs: REFRESH_AFTER_MS,
      services: slots,
      activity: merged.activity,
      failures
    })
  }))

  router.post('/api/v1/cache-operations', asyncRoute(async (request, response) => {
    requireOrigin(request, config.origin)
    const { sessionId, session } = authenticate(request, store, cookieName)
    request.cacheAudit.sessionAuditId = session.auditId
    requireCSRF(request, session.csrfToken)
    enforceRateLimit(limiter.attemptCacheOperation(sessionId), response)
    requireJSONContentType(request)
    const command = validateCacheOperationRequest(await readStrictJSON(request))
    Object.assign(request.cacheAudit, { operation: command.operation, targets: command.targets, commit: command.commit || null })

    const startedAt = new Date(now()).toISOString()
    request.cacheAudit.dispatched = true
    try {
      const targets = await Promise.all(command.targets.map(service => attemptCacheTarget(
        service,
        service === 'downloader' ? downloader : builder,
        command,
        request.correlationId
      )))
      const outcome = deriveCacheOutcome(targets)
      Object.assign(request.cacheAudit, { outcome, targetOutcomes: targets })
      const result = validateCacheOperationResponse({
        correlationId: request.correlationId,
        operation: command.operation,
        startedAt,
        completedAt: new Date(now()).toISOString(),
        outcome,
        targets
      })
      response.status(200).json(result)
    } finally {
      emitCacheAudit(request, log, now)
    }
  }))

  router.delete('/api/v1/session', (request, response, next) => {
    try {
      requireOrigin(request, config.origin)
      const { sessionId, session } = authenticate(request, store, cookieName)
      requireCSRF(request, session.csrfToken)
      store.revoke(sessionId)
      limiter.removeSession(sessionId)
      response.set('Set-Cookie', clearSessionCookie(cookieName, config.protocol))
      response.status(204).end()
    } catch (error) {
      next(error)
    }
  })

  router.use('/api', (request, response) => sendNotFound(response, request.correlationId))
  router.use((request, response) => response.sendStatus(404))
  router.use((error, request, response, next) => {
    if (response.headersSent) return next(error)
    if (request.cacheAudit) {
      request.cacheAudit.outcome = 'failed'
      request.cacheAudit.errorCodes.push(safeMutationErrorCode(error))
    }
    const result = errorBody(error, request.correlationId)
    response.status(result.status).json(result.body)
  })
  return router
}

function authenticate (request, store, cookieName) {
  const sessionId = readSessionId(request, cookieName)
  const session = store.authenticate(sessionId)
  if (!session) throw new OpsHttpError(401, 'UNAUTHORIZED', 'Authentication required')
  return { sessionId, session }
}

function exactFile (route, file) {
  return (request, response, next) => {
    if (request.path !== route) return next()
    response.sendFile(path.join(STATIC_DIR, file))
  }
}

function snapshotRequest (correlationId) {
  return { correlationId, maxResponseBytes: MAX_SNAPSHOT_BYTES, timeout: SNAPSHOT_TIMEOUT_MS, timeoutThroughBody: true }
}

async function attemptCacheTarget (service, client, command, correlationId) {
  try {
    const result = validateCacheOperationResponse(await deadline(client.json('/v1/ops/cache-operations', {
      method: 'POST',
      body: { ...command, targets: [service] },
      correlationId,
      maxRequestBytes: 4 * 1024,
      maxResponseBytes: MAX_CACHE_OPERATION_BYTES,
      timeout: CACHE_OPERATION_TIMEOUT_MS,
      timeoutThroughBody: true
    }), CACHE_OPERATION_TIMEOUT_MS))
    if (result.correlationId !== correlationId || result.operation !== command.operation ||
        result.targets.length !== 1 || result.targets[0].service !== service) {
      throw Object.assign(new Error('Incompatible cache operation response'), { code: 'INCOMPATIBLE_SCHEMA' })
    }
    return result.targets[0]
  } catch (error) {
    return failedCacheTarget(service, command.operation, safeMutationErrorCode(error), isAmbiguousMutationError(error))
  }
}

function failedCacheTarget (service, operation, code, ambiguous) {
  const target = {
    service,
    outcome: ambiguous ? 'unknown' : 'failed',
    removedEntries: 0,
    freedBytes: 0,
    absent: false,
    skippedInUse: 0,
    error: { code, message: ambiguous ? 'Cache operation outcome is unknown' : 'Cache operation failed' }
  }
  if (operation !== 'cache.clear') target.skippedChanged = 0
  return target
}

function isAmbiguousMutationError (error) {
  return ['SERVICE_TIMEOUT', 'SERVICE_RESPONSE_TOO_LARGE', 'INVALID_SERVICE_RESPONSE', 'INCOMPATIBLE_SCHEMA'].includes(error?.code)
}

function safeMutationErrorCode (error) {
  if (error?.code === 'SERVICE_TIMEOUT') return 'SERVICE_TIMEOUT'
  if (['SERVICE_RESPONSE_TOO_LARGE', 'INVALID_SERVICE_RESPONSE', 'INCOMPATIBLE_SCHEMA'].includes(error?.code)) return 'INCOMPATIBLE_SCHEMA'
  if (error?.code === 'SERVICE_UNAVAILABLE') return 'SERVICE_UNAVAILABLE'
  if (error instanceof OpsHttpError) return error.code
  return 'SERVICE_REJECTED'
}

function cacheAudit (request, now) {
  return {
    startedAt: now(),
    sessionAuditId: null,
    source: null,
    userAgent: safeUserAgent(request.headers['user-agent']),
    operation: null,
    targets: [],
    commit: null,
    dispatched: false,
    outcome: 'failed',
    targetOutcomes: [],
    errorCodes: [],
    emitted: false
  }
}

function emitCacheAudit (request, log, now) {
  const audit = request.cacheAudit
  if (!audit || audit.emitted) return
  audit.emitted = true
  const errorCodes = [...new Set([
    ...audit.errorCodes,
    ...audit.targetOutcomes.map(target => target.error?.code).filter(Boolean)
  ])].slice(0, 8)
  log({
    time: new Date(now()).toISOString(),
    action: 'cache_operation',
    correlationId: request.correlationId,
    sessionAuditId: audit.sessionAuditId,
    source: audit.source,
    userAgent: audit.userAgent,
    operation: audit.operation,
    targets: audit.targets,
    commit: audit.commit,
    dispatchStatus: audit.dispatched ? 'dispatched' : 'not_dispatched',
    outcome: audit.outcome,
    targetOutcomes: audit.targetOutcomes.map(target => ({
      service: target.service,
      outcome: target.outcome,
      removedEntries: target.removedEntries,
      freedBytes: target.freedBytes,
      absent: target.absent,
      skippedInUse: target.skippedInUse,
      ...(target.skippedChanged === undefined ? {} : { skippedChanged: target.skippedChanged })
    })),
    errorCodes,
    durationMs: Math.max(0, now() - audit.startedAt)
  })
}

function safeUserAgent (value) {
  if (typeof value !== 'string') return null
  const userAgent = value.toLowerCase()
  if (userAgent.includes('firefox/') || userAgent.includes('fxios/')) return 'firefox'
  if (['chromium/', 'chrome/', 'crios/', 'edg/', 'edga/', 'edgios/', 'opr/'].some(token => userAgent.includes(token))) return 'chromium'
  if (userAgent.includes('safari/')) return 'safari'
  return 'other'
}

async function attemptSnapshot (service, provider, states, now) {
  const state = states[service]
  const attempt = ++state.attempt
  const lastAttemptAt = new Date(now()).toISOString()
  state.lastAttemptAt = lastAttemptAt
  try {
    const snapshot = validateServiceSnapshot(await deadline(provider(), SNAPSHOT_TIMEOUT_MS), service)
    return { service, attempt, lastAttemptAt, snapshot, error: null }
  } catch (error) {
    return { service, attempt, lastAttemptAt, snapshot: null, error: slotError(error) }
  }
}

function commitAttempt (attempt, state) {
  if (attempt.snapshot && attempt.attempt >= state.lastSuccessAttempt) {
    state.lastSuccess = attempt.snapshot
    state.lastSuccessAttempt = attempt.attempt
  }
  if (attempt.attempt === state.attempt) state.error = attempt.error
}

function deadline (promise, milliseconds) {
  let timer
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Service deadline exceeded'), { code: 'SERVICE_TIMEOUT' })), milliseconds)
  })
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer))
}

function slotError (error) {
  return { code: SLOT_ERROR_CODES.has(error?.code) ? error.code : 'SERVICE_UNAVAILABLE' }
}

function deriveRouterSnapshot (snapshot, slots) {
  const dependencies = ['downloader', 'builder'].map(name => {
    const slot = slots[name]
    return {
      name,
      status: slot.freshness === 'fresh' ? 'available' : slot.freshness === 'stale' ? 'degraded' : 'unavailable',
      lastAttemptAt: slot.lastAttemptAt,
      lastSuccessAt: slot.lastSuccessAt,
      lastFailureAt: slot.error ? slot.lastAttemptAt : null,
      lastLatencyMs: null,
      errorCode: slot.error?.code || null
    }
  })
  const downstreamStatus = dependencies.some(dependency => dependency.status === 'unavailable')
    ? 'unavailable'
    : dependencies.some(dependency => dependency.status === 'degraded') ? 'degraded' : 'available'
  const reasonCode = downstreamStatus === 'available' ? null : 'DOWNSTREAM_' + downstreamStatus.toUpperCase()
  const capabilities = [
    { name: 'public_file_delivery', status: downstreamStatus, reasonCode },
    { name: 'console_read', status: downstreamStatus, reasonCode },
    { name: 'console_cache_control', status: downstreamStatus, reasonCode }
  ]
  const reasons = [...new Set(capabilities.map(capability => capability.reasonCode).filter(Boolean))]
    .map(code => ({ code, message: `A downstream service is ${downstreamStatus}` }))
  return {
    ...snapshot,
    health: { status: capabilities.every(capability => capability.status === 'unavailable') ? 'unhealthy' : reasons.length ? 'degraded' : 'healthy', reasons },
    capabilities,
    dependencies
  }
}

function defaultRouterService () {
  const publicRouter = require('../router')
  return { snapshot: publicRouter.opsSnapshot, telemetry: publicRouter.opsTelemetry }
}

function readSessionId (request, cookieName) {
  const header = request.headers.cookie
  if (typeof header !== 'string' || Buffer.byteLength(header) > 4096) return undefined
  const values = header.split(';')
    .map(cookie => cookie.trim())
    .filter(cookie => cookie.startsWith(`${cookieName}=`))
    .map(cookie => cookie.slice(cookieName.length + 1))
  return values.length === 1 && SESSION_ID.test(values[0]) ? values[0] : undefined
}

function sessionCookie (name, value, protocol) {
  const secure = protocol === 'https' ? '; Secure' : ''
  return `${name}=${value}${secure}; HttpOnly; SameSite=Strict; Path=/`
}

function clearSessionCookie (name, protocol) {
  const secure = protocol === 'https' ? '; Secure' : ''
  return `${name}=; Max-Age=0${secure}; HttpOnly; SameSite=Strict; Path=/`
}

function enforceRateLimit (result, response) {
  if (result.allowed) return
  response.set('Retry-After', String(result.retryAfter))
  throw new OpsHttpError(429, 'RATE_LIMITED', 'Too many requests')
}

function authenticationFailed () {
  return new OpsHttpError(401, 'UNAUTHORIZED', 'Authentication failed')
}

function sendNotFound (response, correlationId) {
  const result = errorBody(new OpsHttpError(404, 'NOT_FOUND', 'Console route not found'), correlationId)
  response.status(result.status).json(result.body)
}

function logStatus (event) {
  console.log(JSON.stringify(event)) // eslint-disable-line no-console
}

module.exports = { createOpsConsoleRouter }
