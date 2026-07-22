'use strict'

const http = require('node:http')

const service = process.env.OPS_TEST_SERVICE
const token = process.env.INTERNAL_SERVICE_TOKEN
const port = Number(process.env.PORT || 8080)
const commit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const modes = { snapshot: 'fresh', cache: 'healthy' }
const calls = { snapshot: 0, cache: 0 }

if (!['downloader', 'builder'].includes(service) || !token) throw new Error('Invalid fixture configuration')

http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://fixture')
    if (url.pathname === '/health') return json(response, 200, { status: 'ok' })
    if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/__ops-test/')) {
      if (request.headers.authorization !== `Bearer ${token}`) return json(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } })
    }

    if (request.method === 'POST' && url.pathname === '/__ops-test/control') {
      const body = await readJSON(request)
      if (body.snapshot && !['fresh', 'slow', 'disconnect', 'malformed', 'oversized'].includes(body.snapshot)) return json(response, 400, { ok: false })
      if (body.cache && !['healthy', 'slow', 'disconnect'].includes(body.cache)) return json(response, 400, { ok: false })
      if (body.snapshot) modes.snapshot = body.snapshot
      if (body.cache) modes.cache = body.cache
      if (body.resetCounts) Object.assign(calls, { snapshot: 0, cache: 0 })
      return json(response, 200, { ok: true })
    }
    if (request.method === 'GET' && url.pathname === '/__ops-test/status') return json(response, 200, { service, modes, calls })

    if (request.method === 'GET' && url.pathname === '/v1/ops/snapshot') {
      calls.snapshot++
      if (modes.snapshot === 'slow') await delay(1700)
      if (modes.snapshot === 'disconnect') return request.socket.destroy()
      if (modes.snapshot === 'malformed') return raw(response, 200, 'application/json', '{not-json')
      if (modes.snapshot === 'oversized') return raw(response, 200, 'application/json', JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }))
      return json(response, 200, snapshot(request.headers['x-correlation-id']))
    }

    if (request.method === 'POST' && url.pathname === '/v1/ops/cache-operations') {
      calls.cache++
      const body = await readJSON(request)
      if (modes.cache === 'slow') await delay(10500)
      if (modes.cache === 'disconnect') return request.socket.destroy()
      const removedEntries = body.operation === 'cache.clear' ? 1 : 0
      const target = {
        service,
        outcome: removedEntries ? 'completed' : 'no_op',
        removedEntries,
        freedBytes: removedEntries ? 128 : 0,
        absent: body.operation === 'cache.evict_commit',
        skippedInUse: 0,
        error: null,
        ...(body.operation === 'cache.clear' ? {} : { skippedChanged: 0 })
      }
      const now = new Date().toISOString()
      return json(response, 200, {
        correlationId: request.headers['x-correlation-id'],
        operation: body.operation,
        startedAt: now,
        completedAt: now,
        outcome: target.outcome,
        targets: [target]
      })
    }

    if (service === 'downloader' && request.method === 'POST' && url.pathname === '/v1/resolve') {
      const body = await readJSON(request)
      return json(response, 200, { commit, needsEsbuild: body.ref === 'master', rate: {} })
    }
    if (service === 'downloader' && request.method === 'GET' && url.pathname.startsWith('/v1/files/')) {
      return json(response, 404, { error: { code: 'FILE_NOT_FOUND', message: 'File was not found' } })
    }
    if (service === 'builder' && request.method === 'POST' && url.pathname === '/v1/build') {
      const body = await readJSON(request)
      response.setHeader('X-Built-With', body.mode === 'esbuild' ? 'esbuild' : 'assembler')
      return raw(response, 200, 'application/javascript', body.mode === 'dashboards' ? '/* Dashboards fixture */' : '/* Highcharts fixture */')
    }
    if (request.method === 'POST' && url.pathname === '/v1/cleanup') return json(response, 200, { removed: '0' })
    json(response, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } })
  } catch (error) {
    json(response, 400, { error: { code: 'INVALID_REQUEST', message: 'Invalid request' } })
  }
}).listen(port, '0.0.0.0')

function snapshot (correlationId) {
  const now = new Date().toISOString()
  return {
    schemaVersion: 1,
    service,
    instanceId: `${service}-fixture`,
    startedAt: now,
    observedAt: now,
    health: { status: 'healthy', reasons: [] },
    capabilities: [{ name: service === 'builder' ? 'build_delivery' : 'source_delivery', status: 'available', reasonCode: null }],
    queues: [{ name: service === 'builder' ? 'build' : 'download', active: 0, queued: 0, limit: 2, available: 2, oldestQueuedAgeMs: null }],
    cache: {
      entryCount: 1,
      totalBytes: 128,
      idleExpiryMs: 60000,
      entriesTruncated: false,
      entries: [{ commit, sizeBytes: 128, lastAccessedAt: now, expiresAt: new Date(Date.now() + 60000).toISOString(), inUse: 0 }]
    },
    dependencies: [],
    telemetry: { activityDropped: 0, completedEvicted: 0, failuresEvicted: 0, spansDropped: 0 },
    activity: correlationId ? [] : [],
    failures: []
  }
}

function readJSON (request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    request.on('data', chunk => {
      bytes += chunk.length
      if (bytes > 65536) request.destroy()
      else chunks.push(chunk)
    })
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (error) { reject(error) }
    })
    request.on('error', reject)
  })
}

function json (response, status, body) {
  raw(response, status, 'application/json', JSON.stringify(body))
}

function raw (response, status, type, body) {
  if (response.destroyed) return
  response.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) })
  response.end(body)
}

function delay (milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
