'use strict'

const { randomUUID } = require('node:crypto')

const LIMITS = Object.freeze({
  active: 100,
  completed: 200,
  completedAgeMs: 15 * 60 * 1000,
  failures: 100,
  failureAgeMs: 60 * 60 * 1000,
  spans: 8,
  cacheEntries: 200,
  windowSamples: 200,
  healthWindowMs: 5 * 60 * 1000,
  staleMs: 2 * 60 * 1000
})
const SERVICES = new Set(['router', 'downloader', 'builder'])
const DEPENDENCIES = new Set(['github', 'downloader', 'builder'])
const CAPABILITIES = Object.freeze({
  router: new Set(['public_file_delivery', 'console_read', 'console_cache_control']),
  downloader: new Set(['ref_resolution', 'source_file_delivery', 'source_archive_delivery', 'cache_control']),
  builder: new Set(['build_delivery', 'cache_control'])
})
const OUTCOMES = new Set(['succeeded', 'failed', 'rejected', 'aborted'])
const BUILD_MODES = new Set(['legacy', 'webpack', 'dashboards', 'esbuild', 'static'])
const CODE = /^[\x21-\x7e]{1,64}$/
const SHA = /^[0-9a-f]{40}$/
const INTERNAL_SUMMARY = 'An internal error occurred'

function iso (time) {
  return new Date(time).toISOString()
}

function integer (value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function safeCode (value) {
  return typeof value === 'string' && CODE.test(value) ? value : null
}

function boundedText (value, maximum = 256) {
  if (typeof value !== 'string') return null
  const characters = [...value].filter(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
  while (Buffer.byteLength(characters.join('')) > maximum) characters.pop()
  return characters.join('')
}

function normalizeResource (value) {
  if (typeof value !== 'string' || value.includes('://') || value.includes('?') || value.includes('#') || value.includes('\\')) return null
  const result = boundedText(value)
  if (!result || result.split('/').includes('..') || !/^[\p{L}\p{N}._@/+-]+$/u.test(result)) return null
  return result
}

function safeOutcome (value, active = false) {
  if (active) return { status: 'succeeded', httpStatus: null, code: null }
  const status = OUTCOMES.has(value?.status) ? value.status : 'failed'
  const httpStatus = integer(value?.httpStatus)
  return {
    status,
    httpStatus: httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null,
    code: safeCode(value?.code)
  }
}

class Telemetry {
  constructor ({ service, operations = [], routes = [], failureSummaries = {}, now = Date.now, instanceId = randomUUID() }) {
    if (!SERVICES.has(service)) throw new Error('Invalid telemetry service')
    this.service = service
    this.operations = new Set(operations.filter(safeCode))
    this.routes = new Set(routes.filter(route => typeof route === 'string' && boundedText(route) === route))
    this.failureSummaries = new Map([['INTERNAL_ERROR', INTERNAL_SUMMARY]])
    for (const [code, summary] of Object.entries(failureSummaries)) {
      if (safeCode(code) && boundedText(summary) === summary) this.failureSummaries.set(code, summary)
    }
    this.now = now
    this.instanceId = safeCode(instanceId) || randomUUID()
    this.startedAt = iso(now())
    this.active = new Map()
    this.completed = []
    this.failures = []
    this.fragments = new Map()
    this.dependencyHistory = new Map()
    this.window = []
    this.counters = { activityDropped: 0, completedEvicted: 0, failuresEvicted: 0, spansDropped: 0 }
  }

  startTrace ({ correlationId, method, route, commit = null, resource = null, buildMode = null }) {
    this.prune()
    if (!safeCode(correlationId) || !safeCode(method) || !this.routes.has(route)) return null
    if (this.active.has(correlationId)) return structuredClone(this.active.get(correlationId))
    if (this.active.size >= LIMITS.active) {
      const oldest = this.active.keys().next().value
      this.active.delete(oldest)
      this.counters.activityDropped++
    }
    const started = this.now()
    const trace = {
      correlationId,
      state: 'active',
      startedAt: iso(started),
      completedAt: null,
      durationMs: null,
      request: {
        method,
        route,
        commit: SHA.test(commit || '') ? commit : null,
        resource: normalizeResource(resource),
        buildMode: BUILD_MODES.has(buildMode) ? buildMode : null
      },
      outcome: safeOutcome(null, true),
      spans: []
    }
    Object.defineProperty(trace, '_started', { value: started, enumerable: false })
    this.active.set(correlationId, trace)
    return structuredClone(trace)
  }

  completeTrace (correlationId, outcome) {
    const trace = this.active.get(correlationId)
    if (!trace) return null
    const completed = this.now()
    this.active.delete(correlationId)
    trace.state = 'completed'
    trace.completedAt = iso(completed)
    trace.durationMs = Math.max(0, completed - trace._started)
    trace.outcome = safeOutcome(outcome)
    trace.spans = this.takeFragments(correlationId)
    Object.defineProperty(trace, '_completed', { value: completed, enumerable: false })
    this.completed.push(trace)
    this.recordWindow(trace.outcome.status, trace.durationMs, outcome?.timeoutMs)
    this.prune()
    return structuredClone(trace)
  }

  startSpan (correlationId, operation) {
    if (!safeCode(correlationId) || !this.operations.has(operation)) return null
    if (!this.fragments.has(correlationId) && this.fragments.size >= LIMITS.active) {
      const oldest = this.fragments.keys().next().value
      this.counters.spansDropped += this.fragments.get(oldest).length
      this.fragments.delete(oldest)
    }
    const spans = this.fragments.get(correlationId) || []
    if (spans.length >= LIMITS.spans) {
      this.counters.spansDropped++
      return null
    }
    const started = this.now()
    const span = {
      service: this.service,
      operation,
      state: 'active',
      startedAt: iso(started),
      completedAt: null,
      durationMs: null,
      outcome: { status: 'active', httpStatus: null, code: null }
    }
    Object.defineProperty(span, '_started', { value: started, enumerable: false })
    spans.push(span)
    this.fragments.set(correlationId, spans)
    return structuredClone(span)
  }

  completeSpan (correlationId, operation, outcome) {
    const span = this.fragments.get(correlationId)?.find(entry => entry.operation === operation && entry.state === 'active')
    if (!span) return null
    const completed = this.now()
    span.state = 'completed'
    span.completedAt = iso(completed)
    span.durationMs = Math.max(0, completed - span._started)
    span.outcome = safeOutcome(outcome)
    return structuredClone(span)
  }

  takeFragments (correlationId) {
    const spans = this.fragments.get(correlationId) || []
    this.fragments.delete(correlationId)
    return structuredClone(spans)
  }

  recordFailure ({ correlationId, operation, code, httpStatus = null, commit = null }) {
    this.prune()
    if (!safeCode(correlationId) || !this.operations.has(operation)) return null
    const safeFailureCode = safeCode(code) && this.failureSummaries.has(code) ? code : 'INTERNAL_ERROR'
    const occurred = this.now()
    const status = integer(httpStatus)
    const failure = {
      occurredAt: iso(occurred),
      correlationId,
      service: this.service,
      operation,
      code: safeFailureCode,
      summary: this.failureSummaries.get(safeFailureCode),
      httpStatus: status >= 100 && status <= 599 ? status : null,
      commit: SHA.test(commit || '') ? commit : null
    }
    Object.defineProperty(failure, '_occurred', { value: occurred, enumerable: false })
    this.failures.push(failure)
    this.prune()
    return structuredClone(failure)
  }

  recordDependency (name, { succeeded, latencyMs = null, errorCode = null }) {
    if (!DEPENDENCIES.has(name)) return null
    const history = this.dependencyHistory.get(name) || []
    const safeDependencyCode = safeCode(errorCode) && this.failureSummaries.has(errorCode) ? errorCode : 'INTERNAL_ERROR'
    history.push({ at: this.now(), succeeded: succeeded === true, latencyMs: integer(latencyMs), errorCode: safeDependencyCode })
    this.dependencyHistory.set(name, history)
    this.prune()
    return this.dependencies().find(dependency => dependency.name === name)
  }

  recordWindow (status, durationMs, timeoutMs = null) {
    this.window.push({ at: this.now(), status: OUTCOMES.has(status) ? status : 'failed', durationMs: integer(durationMs) || 0, timeoutMs: integer(timeoutMs) })
    this.prune()
  }

  healthSignals (queues = []) {
    this.prune()
    const completed = this.window.length
    const failures = this.window.filter(sample => sample.status === 'failed' || sample.status === 'rejected').length
    const latencies = this.window.filter(sample => sample.timeoutMs !== null).sort((a, b) => a.durationMs - b.durationMs)
    const p95 = latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null
    return {
      queueSaturated: queues.some(queue => queue.active + queue.queued >= queue.limit),
      capacityRejected: this.window.some(sample => sample.status === 'rejected'),
      reliabilityDegraded: completed >= 10 && failures >= 3 && failures / completed >= 0.1,
      latencyDegraded: latencies.length >= 10 && p95.durationMs >= p95.timeoutMs * 0.8,
      dependencyDegraded: this.dependencies().some(dependency => dependency.status === 'degraded' || dependency.status === 'unavailable')
    }
  }

  dependencies () {
    this.prune()
    return [...this.dependencyHistory].map(([name, history]) => {
      const latest = history.at(-1)
      const successes = history.filter(entry => entry.succeeded)
      const failures = history.filter(entry => !entry.succeeded)
      const status = !latest
        ? 'unknown'
        : latest.succeeded
          ? 'available'
          : history.at(-2)?.succeeded
            ? 'degraded'
            : 'unavailable'
      return {
        name,
        status,
        lastAttemptAt: latest ? iso(latest.at) : null,
        lastSuccessAt: successes.length ? iso(successes.at(-1).at) : null,
        lastFailureAt: failures.length ? iso(failures.at(-1).at) : null,
        lastLatencyMs: latest?.latencyMs ?? null,
        errorCode: latest?.succeeded ? null : latest?.errorCode ?? 'INTERNAL_ERROR'
      }
    }).sort((a, b) => a.name.localeCompare(b.name))
  }

  activity () {
    this.prune()
    return [...this.active.values()].sort((a, b) => b._started - a._started).concat([...this.completed].sort((a, b) => b._completed - a._completed)).map(value => structuredClone(value))
  }

  getFailures () {
    this.prune()
    return [...this.failures].sort((a, b) => b._occurred - a._occurred).map(value => structuredClone(value))
  }

  snapshot ({ capabilities, queues = [], cache = null }) {
    const observedAt = iso(this.now())
    const normalizedCapabilities = capabilities.map(capability => ({
      name: CAPABILITIES[this.service].has(capability.name) ? capability.name : null,
      status: capability.status === 'unavailable' ? 'unavailable' : capability.status === 'degraded' ? 'degraded' : 'available',
      reasonCode: capability.status === 'available' ? null : safeCode(capability.reasonCode) || 'INTERNAL_ERROR'
    })).filter(capability => capability.name)
    const affected = normalizedCapabilities.filter(capability => capability.status !== 'available')
    const unavailable = normalizedCapabilities.length > 0 && affected.length === normalizedCapabilities.length && affected.every(capability => capability.status === 'unavailable')
    return {
      schemaVersion: 1,
      service: this.service,
      instanceId: this.instanceId,
      startedAt: this.startedAt,
      observedAt,
      health: {
        status: unavailable ? 'unhealthy' : affected.length ? 'degraded' : 'healthy',
        reasons: [...new Set(normalizedCapabilities.map(capability => capability.reasonCode).filter(Boolean))].map(code => ({ code, message: code.replaceAll('_', ' ').toLowerCase() }))
      },
      capabilities: normalizedCapabilities,
      queues: queues.map(queue => queueSnapshot(queue.name, queue)),
      cache,
      dependencies: this.dependencies(),
      telemetry: { ...this.counters },
      activity: this.activity(),
      failures: this.getFailures()
    }
  }

  prune () {
    const now = this.now()
    const trim = (items, age, maximum, counter) => {
      let removed = 0
      while (items.length && (now - (items[0]._completed ?? items[0]._occurred ?? items[0].at) > age || items.length > maximum)) {
        items.shift()
        removed++
      }
      if (counter) this.counters[counter] += removed
    }
    trim(this.completed, LIMITS.completedAgeMs, LIMITS.completed, 'completedEvicted')
    trim(this.failures, LIMITS.failureAgeMs, LIMITS.failures, 'failuresEvicted')
    trim(this.window, LIMITS.healthWindowMs, LIMITS.windowSamples)
    for (const history of this.dependencyHistory.values()) trim(history, LIMITS.healthWindowMs, LIMITS.windowSamples)
  }
}

function queueSnapshot (name, metrics) {
  if (name !== 'download' && name !== 'build') throw new Error('Invalid queue name')
  const active = integer(metrics.active) || 0
  const queued = integer(metrics.queued) || 0
  const limit = integer(metrics.limit) || 0
  return {
    name,
    active,
    queued,
    limit,
    available: Math.max(0, limit - active - queued),
    oldestQueuedAgeMs: queued ? integer(metrics.oldestQueuedAgeMs) : null
  }
}

function cacheSnapshot (entries, idleExpiryMs) {
  const safeEntries = entries.filter(entry => SHA.test(entry.commit || '') &&
    integer(entry.sizeBytes) !== null &&
    integer(entry.inUse) !== null &&
    Number.isFinite(Date.parse(entry.lastAccessedAt)) &&
    Number.isFinite(Date.parse(entry.expiresAt)))
  const visible = [...safeEntries].sort((a, b) => Date.parse(b.lastAccessedAt) - Date.parse(a.lastAccessedAt)).slice(0, LIMITS.cacheEntries)
  return {
    entryCount: safeEntries.length,
    totalBytes: safeEntries.reduce((total, entry) => total + entry.sizeBytes, 0),
    idleExpiryMs: integer(idleExpiryMs) || 0,
    entriesTruncated: safeEntries.length > LIMITS.cacheEntries,
    entries: visible.map(entry => ({
      commit: entry.commit,
      sizeBytes: entry.sizeBytes,
      lastAccessedAt: iso(Date.parse(entry.lastAccessedAt)),
      expiresAt: iso(Date.parse(entry.expiresAt)),
      inUse: entry.inUse
    }))
  }
}

function mergeActivity (canonicalTraces, fragments, operations = []) {
  const traces = canonicalTraces.map(value => structuredClone(value))
  const byCorrelation = new Map(traces.map(trace => [trace.correlationId, trace]))
  const allowedOperations = new Set(operations.filter(safeCode))
  let spansDropped = 0
  for (const fragment of fragments) {
    const trace = byCorrelation.get(fragment.correlationId)
    if (!trace || !Array.isArray(fragment.spans)) continue
    const keys = new Set(trace.spans.map(span => `${trace.correlationId}:${span.service}:${span.operation}`))
    for (const span of fragment.spans) {
      const key = `${trace.correlationId}:${span.service}:${span.operation}`
      if (!SERVICES.has(span.service) || !allowedOperations.has(span.operation) || keys.has(key)) continue
      if (trace.spans.length >= LIMITS.spans) {
        spansDropped++
        continue
      }
      trace.spans.push({
        service: span.service,
        operation: span.operation,
        state: span.state === 'active' ? 'active' : 'completed',
        startedAt: span.startedAt,
        completedAt: span.state === 'active' ? null : span.completedAt,
        durationMs: span.state === 'active' ? null : integer(span.durationMs),
        outcome: {
          status: safeCode(span.outcome?.status) || 'failed',
          httpStatus: integer(span.outcome?.httpStatus),
          code: safeCode(span.outcome?.code)
        }
      })
      keys.add(key)
    }
  }
  return { activity: traces, spansDropped }
}

function serviceSlot ({ lastAttemptAt = null, lastSuccess = null, error = null }, observedAt) {
  const observed = typeof observedAt === 'number' ? observedAt : Date.parse(observedAt)
  const successAt = lastSuccess && Date.parse(lastSuccess.observedAt)
  if (!lastSuccess || !Number.isFinite(successAt) || observed - successAt > LIMITS.staleMs) {
    return { freshness: 'unknown', lastAttemptAt, lastSuccessAt: lastSuccess?.observedAt || null, ageMs: null, snapshot: null, error: safeSlotError(error) }
  }
  const ageMs = Math.max(0, observed - successAt)
  return {
    freshness: error ? 'stale' : 'fresh',
    lastAttemptAt,
    lastSuccessAt: lastSuccess.observedAt,
    ageMs,
    snapshot: structuredClone(lastSuccess),
    error: safeSlotError(error)
  }
}

function safeSlotError (error) {
  if (!error) return null
  return { code: safeCode(error.code) || 'INTERNAL_ERROR', message: 'Service snapshot unavailable' }
}

module.exports = {
  LIMITS,
  Telemetry,
  cacheSnapshot,
  mergeActivity,
  normalizeResource,
  queueSnapshot,
  serviceSlot
}
