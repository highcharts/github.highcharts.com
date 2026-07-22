'use strict'

const { expect } = require('chai')
const http = require('node:http')
const express = require('express')
const { describe, it } = require('mocha')
const sinon = require('sinon')
const { createInternalOpsRouter, MAX_REQUEST_BYTES } = require('../app/ops/internal-router')
const { createServiceClient } = require('../app/service-client')

const TIME = '2026-07-17T12:00:00.000Z'

function snapshot () {
  return {
    schemaVersion: 1,
    service: 'builder',
    instanceId: 'builder-instance',
    startedAt: TIME,
    observedAt: TIME,
    health: { status: 'healthy', reasons: [] },
    capabilities: [{ name: 'build_delivery', status: 'available', reasonCode: null }],
    queues: [],
    cache: null,
    dependencies: [],
    telemetry: { activityDropped: 0, completedEvicted: 0, failuresEvicted: 0, spansDropped: 0 },
    activity: [],
    failures: []
  }
}

function target (values = {}) {
  return {
    service: 'builder',
    outcome: 'no_op',
    removedEntries: 0,
    freedBytes: 0,
    absent: true,
    skippedInUse: 0,
    skippedChanged: 0,
    error: null,
    ...values
  }
}

function request (app, path, options = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const request = http.request({ port: server.address().port, path, method: options.method || 'GET', headers: options.headers }, response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          server.close()
          resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) })
        })
      })
      request.on('error', reject)
      request.end(options.body)
    })
  })
}

function appFor (options = {}) {
  const app = express()
  app.use(createInternalOpsRouter({
    token: 'secret',
    service: 'builder',
    snapshot,
    cache: { execute: sinon.stub().resolves(target()) },
    now: () => Date.parse(TIME),
    ...options
  }))
  return app
}

describe('internal operations router', () => {
  it('protects both routes before processing input and returns safe correlated errors', async () => {
    const app = appFor()
    const unauthorized = await request(app, '/v1/ops/snapshot', { headers: { 'X-Correlation-ID': 'request-id' } })
    expect(unauthorized.status).to.equal(401)
    expect(unauthorized.headers['x-correlation-id']).to.equal('request-id')
    expect(JSON.parse(unauthorized.body)).to.deep.equal({ error: { code: 'UNAUTHORIZED', message: 'Authentication required', correlationId: 'request-id' } })

    const failure = await request(appFor({ snapshot: () => { throw new Error('secret path') } }), '/v1/ops/snapshot', { headers: { Authorization: 'Bearer secret' } })
    expect(failure.status).to.equal(500)
    expect(JSON.parse(failure.body).error).to.include({ code: 'INTERNAL_ERROR', message: 'An internal error occurred' })
    expect(failure.body.toString()).not.to.include('secret path')
  })

  it('returns only a validated schema-v1 snapshot and propagates correlation', async () => {
    const provider = sinon.stub().resolves(snapshot())
    const response = await request(appFor({ snapshot: provider }), '/v1/ops/snapshot', {
      headers: { Authorization: 'Bearer secret', 'X-Correlation-ID': 'correlation-id' }
    })
    expect(response.status).to.equal(200)
    expect(response.headers['x-correlation-id']).to.equal('correlation-id')
    expect(response.headers['cache-control']).to.equal('no-store')
    expect(JSON.parse(response.body)).to.deep.equal(snapshot())
    expect(provider.calledOnceWithExactly('correlation-id')).to.equal(true)

    const invalid = await request(appFor({ snapshot: () => ({ ...snapshot(), schemaVersion: 2 }) }), '/v1/ops/snapshot', { headers: { Authorization: 'Bearer secret' } })
    expect(invalid.status).to.equal(500)
    expect(JSON.parse(invalid.body).error.code).to.equal('INTERNAL_ERROR')
  })

  it('strictly bounds and validates service-specific cache commands', async () => {
    const execute = sinon.stub().resolves(target())
    const app = appFor({ cache: { execute } })
    const response = await request(app, '/v1/ops/cache-operations', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json', 'X-Correlation-ID': 'operation-id' },
      body: JSON.stringify({ operation: 'cache.evict_commit', targets: ['builder'], commit: 'a'.repeat(40) })
    })
    expect(response.status).to.equal(200)
    expect(JSON.parse(response.body)).to.deep.equal({
      correlationId: 'operation-id',
      operation: 'cache.evict_commit',
      startedAt: TIME,
      completedAt: TIME,
      outcome: 'no_op',
      targets: [target()]
    })
    expect(execute.calledOnceWithExactly('cache.evict_commit', 'a'.repeat(40))).to.equal(true)

    for (const options of [
      { headers: { Authorization: 'Bearer secret' }, body: '{}' },
      { headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: '{"operation":"cache.clear","operation":"cache.clear","targets":["builder"]}' },
      { headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'cache.clear', targets: ['downloader'] }) },
      { headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: Buffer.alloc(MAX_REQUEST_BYTES + 1, 32) }
    ]) {
      const rejected = await request(app, '/v1/ops/cache-operations', { method: 'POST', ...options })
      expect(rejected.status).to.be.oneOf([400, 413, 415])
    }
    expect(execute.callCount).to.equal(1)
  })
})

describe('bounded internal service JSON transport', () => {
  it('bounds request and response bodies and sends correlation without retries', async () => {
    const fetch = sinon.stub().resolves(new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } }))
    const client = createServiceClient({ baseURL: 'http://builder', token: 'secret', fetch })
    expect(await client.json('/v1/ops/snapshot', { correlationId: 'request-id', maxResponseBytes: 64 })).to.deep.equal({ ok: true })
    expect(fetch.calledOnce).to.equal(true)
    expect(fetch.firstCall.args[1].headers['X-Correlation-ID']).to.equal('request-id')

    let error
    try { await client.json('/v1/ops/cache-operations', { method: 'POST', body: { value: 'x'.repeat(20) }, maxRequestBytes: 8, maxResponseBytes: 64 }) } catch (caught) { error = caught }
    expect(error).to.include({ code: 'REQUEST_TOO_LARGE', status: 413 })
    expect(fetch.calledOnce).to.equal(true)

    fetch.resetBehavior()
    fetch.resolves(new Response(JSON.stringify({ value: 'x'.repeat(100) })))
    try { await client.json('/v1/ops/snapshot', { maxResponseBytes: 32 }) } catch (caught) { error = caught }
    expect(error).to.include({ code: 'SERVICE_RESPONSE_TOO_LARGE', status: 502 })
    expect(fetch.callCount).to.equal(2)
  })
})
