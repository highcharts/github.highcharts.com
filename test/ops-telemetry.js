'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')

const { JobQueue } = require('../app/JobQueue')
const { LIMITS, Telemetry, cacheSnapshot, mergeActivity, normalizeResource, serviceSlot } = require('../app/ops/telemetry')

function clock () {
  let time = Date.parse('2026-01-01T00:00:00.000Z')
  return { now: () => time, advance: amount => { time += amount } }
}

function telemetry (time, options = {}) {
  return new Telemetry({
    service: 'router',
    operations: ['deliver', ...Array.from({ length: LIMITS.spans + 1 }, (_, index) => `operation-${index}`)],
    routes: ['/files/:commit/*'],
    failureSummaries: { UPSTREAM_FAILED: 'Upstream request failed' },
    now: time.now,
    instanceId: 'instance-1',
    ...options
  })
}

describe('operations telemetry', () => {
  it('bounds and expires completed traces and failures deterministically', () => {
    const time = clock()
    const store = telemetry(time)
    const activeStore = telemetry(time)
    for (let index = 0; index <= LIMITS.active; index++) {
      activeStore.startTrace({ correlationId: `active-${index}`, method: 'GET', route: '/files/:commit/*' })
    }
    assert.equal(activeStore.activity().length, LIMITS.active)
    assert.equal(activeStore.activity().some(trace => trace.correlationId === 'active-0'), false)
    assert.equal(activeStore.counters.activityDropped, 1)

    for (let index = 0; index <= LIMITS.completed; index++) {
      store.startTrace({ correlationId: `request-${index}`, method: 'GET', route: '/files/:commit/*' })
      store.completeTrace(`request-${index}`, { status: 'succeeded' })
    }
    assert.equal(store.activity().length, LIMITS.completed)
    assert.equal(store.counters.completedEvicted, 1)

    for (let index = 0; index <= LIMITS.failures; index++) {
      store.recordFailure({ correlationId: `failure-${index}`, operation: 'deliver', code: 'UPSTREAM_FAILED' })
    }
    assert.equal(store.getFailures().length, LIMITS.failures)
    assert.equal(store.counters.failuresEvicted, 1)

    time.advance(LIMITS.failureAgeMs + 1)
    assert.equal(store.getFailures().length, 0)
    assert.equal(store.counters.failuresEvicted, LIMITS.failures + 1)
  })

  it('caps local spans and merges only correlated, unique fragments', () => {
    const time = clock()
    const store = telemetry(time)
    store.startTrace({ correlationId: 'known', method: 'GET', route: '/files/:commit/*' })
    for (let index = 0; index <= LIMITS.spans; index++) {
      store.startSpan('known', `operation-${index}`)
    }
    const trace = store.completeTrace('known', { status: 'succeeded' })
    assert.equal(trace.spans.length, LIMITS.spans)
    assert.equal(store.counters.spansDropped, 1)

    const merged = mergeActivity([trace], [
      { correlationId: 'orphan', spans: [{ service: 'builder', operation: 'build' }] },
      { correlationId: 'known', spans: [{ service: 'builder', operation: 'build' }, { service: 'builder', operation: 'build' }] }
    ], ['build'])
    assert.equal(merged.activity.length, 1)
    assert.equal(merged.activity[0].spans.length, LIMITS.spans)
    assert.equal(merged.spansDropped, 2)
  })

  it('derives passive dependency and rolling health semantics', () => {
    const time = clock()
    const store = telemetry(time)
    assert.deepEqual(store.dependencies(), [])
    assert.equal(store.recordDependency('github', { succeeded: false, errorCode: 'RATE_LIMITED', latencyMs: 10 }).status, 'unavailable')
    assert.equal(store.recordDependency('github', { succeeded: true, latencyMs: 5 }).status, 'available')
    assert.equal(store.recordDependency('github', { succeeded: false, errorCode: 'UPSTREAM_FAILED', latencyMs: 7 }).status, 'degraded')

    for (let index = 0; index < 10; index++) store.recordWindow(index < 3 ? 'failed' : 'succeeded', 80, 100)
    assert.deepEqual(store.healthSignals([]), {
      queueSaturated: false,
      capacityRejected: false,
      reliabilityDegraded: true,
      latencyDegraded: true,
      dependencyDegraded: true
    })
    time.advance(LIMITS.healthWindowMs + 1)
    assert.equal(store.healthSignals([]).reliabilityDegraded, false)
  })

  it('reports queue state without exposing jobs or arguments', async () => {
    const queue = new JobQueue()
    let release
    const blocked = new Promise(resolve => { release = resolve })
    const first = queue.addJob('compile', 'metrics-active', { func: () => blocked, args: ['secret'] })
    const second = queue.addJob('compile', 'metrics-waiting', { func: async () => {}, args: ['also-secret'] })
    const metrics = queue.getMetrics('compile', Date.now() + 25)
    assert.deepEqual(Object.keys(metrics), ['active', 'queued', 'limit', 'available', 'oldestQueuedAgeMs'])
    assert.equal(metrics.active, 1)
    assert.equal(metrics.queued, 1)
    assert.equal(metrics.available, 0)
    assert.ok(metrics.oldestQueuedAgeMs >= 25)
    assert.doesNotMatch(JSON.stringify(metrics), /secret/)
    release()
    await Promise.all([first, second])
  })

  it('assembles bounded cache summaries and deterministic freshness slots', () => {
    const entries = Array.from({ length: LIMITS.cacheEntries + 1 }, (_, index) => ({
      commit: index.toString(16).padStart(40, '0'),
      sizeBytes: 2,
      lastAccessedAt: new Date(index * 1000).toISOString(),
      expiresAt: new Date(index * 1000 + 10000).toISOString(),
      inUse: 0,
      path: '/secret/cache'
    }))
    const cache = cacheSnapshot(entries, 1000)
    assert.equal(cache.entryCount, LIMITS.cacheEntries + 1)
    assert.equal(cache.totalBytes, (LIMITS.cacheEntries + 1) * 2)
    assert.equal(cache.entries.length, LIMITS.cacheEntries)
    assert.equal(cache.entriesTruncated, true)
    assert.doesNotMatch(JSON.stringify(cache), /secret|path/)

    const snapshot = { observedAt: '2026-01-01T00:00:00.000Z', token: undefined }
    assert.equal(serviceSlot({ lastSuccess: snapshot }, snapshot.observedAt).freshness, 'fresh')
    assert.equal(serviceSlot({ lastSuccess: snapshot, error: { code: 'TIMEOUT' } }, Date.parse(snapshot.observedAt) + 1).freshness, 'stale')
    assert.equal(serviceSlot({ lastSuccess: snapshot }, Date.parse(snapshot.observedAt) + LIMITS.staleMs + 1).freshness, 'unknown')
  })

  it('sanitizes request resources and failures by construction', () => {
    const time = clock()
    const store = telemetry(time)
    const trace = store.startTrace({
      correlationId: 'safe-id',
      method: 'GET',
      route: '/files/:commit/*',
      resource: 'https://example.test/private?token=secret',
      headers: { authorization: 'secret' },
      args: ['secret']
    })
    const failure = store.recordFailure({
      correlationId: 'safe-id',
      operation: 'deliver',
      code: 'UNKNOWN',
      summary: 'secret',
      stack: '/Users/private/file.js'
    })
    assert.equal(trace.request.resource, null)
    assert.equal(failure.code, 'INTERNAL_ERROR')
    assert.equal(failure.summary, 'An internal error occurred')
    assert.doesNotMatch(JSON.stringify({ trace, failure }), /secret|authorization|Users|stack/)
  })

  it('truncates bounded text without splitting astral characters', () => {
    const astralLetter = '\u{10400}'
    const exact = `${'a'.repeat(252)}${astralLetter}`
    assert.equal(Buffer.byteLength(exact), 256)
    assert.equal(normalizeResource(exact), exact)
    assert.equal(normalizeResource(`${'a'.repeat(253)}${astralLetter}`), 'a'.repeat(253))
  })
})
