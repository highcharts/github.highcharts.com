'use strict'

const { expect } = require('chai')
const { createHmac } = require('node:crypto')
const http = require('node:http')
const { Readable } = require('node:stream')
const { afterEach, describe, it } = require('mocha')
const sinon = require('sinon')
const { secureToken } = require('../config.json')
const { createRouter, rewriteRef } = require('../app/router')
const { ServiceError } = require('../app/service-client')
const express = require('express')

const SHA = '0123456789abcdef0123456789abcdef01234567'
const servers = []

function response (body, headers = {}) {
  return {
    status: 200,
    headers: new Headers(headers),
    body: Readable.toWeb(Readable.from(body))
  }
}

function services (needsEsbuild = false) {
  return {
    downloader: {
      json: sinon.stub().resolves({ commit: SHA, needsEsbuild, rate: { remaining: 12, reset: 1234 } }),
      request: sinon.stub().resolves(response('downloaded'))
    },
    builder: {
      request: sinon.stub().resolves(response('built', { 'X-Built-With': 'assembler' })),
      json: sinon.stub().resolves({ removed: [] })
    }
  }
}

function request (router, path, options = {}) {
  return new Promise((resolve, reject) => {
    const app = express()
    app.use(express.json({ verify: (req, res, body) => { req.rawBody = body.toString() } }))
    app.use(router)
    const server = app.listen(0, () => {
      servers.push(server)
      const req = http.request({ port: server.address().port, path, method: options.method || 'GET', headers: options.headers }, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
      })
      req.on('error', reject)
      req.end(options.body)
    })
  })
}

describe('public router delegation', () => {
  afterEach(() => {
    while (servers.length) servers.pop().close()
    delete process.env.WEBHOOK_SECRET
  })

  it('rewrites single and slash branch prefixes only', () => {
    expect(rewriteRef('/trettan/highcharts.js?x', 'trettan', SHA)).to.equal(`/${SHA}/highcharts.js?x`)
    expect(rewriteRef('/feature/foo/modules/a.js', 'feature/foo', SHA)).to.equal(`/${SHA}/modules/a.js`)
    expect(rewriteRef('/highcharts.js', 'master', SHA)).to.equal('/highcharts.js')
  })

  it('streams ordinary files from downloader with public cache, ETag, and rate headers', async () => {
    const clients = services()
    const result = await request(createRouter({ ...clients, disableRateLimit: true }), '/trettan/highcharts.js')
    expect(result).to.include({ status: 200, body: 'downloaded' })
    expect(result.headers).to.include({ etag: SHA, 'cache-control': 'max-age=3600', 'cdn-cache-control': 'max-age=3600', 'x-github-ratelimit-remaining': '12' })
    expect(clients.downloader.request.firstCall.args[0]).to.equal(`/v1/files/${SHA}/js/highcharts.src.js`)
  })

  it('falls back to explicit legacy builder mode while retaining downloader rate metadata', async () => {
    const clients = services()
    clients.downloader.request.rejects(new ServiceError('FILE_NOT_FOUND', 'File was not found', 404))
    const result = await request(createRouter({ ...clients, disableRateLimit: true }), '/feature/foo/modules/exporting.js')
    expect(result).to.include({ status: 200, body: 'built' })
    expect(result.headers).to.include({ 'x-built-with': 'assembler', 'x-github-ratelimit-remaining': '12' })
    expect(clients.builder.request.firstCall.args[1].body).to.include({ commit: SHA, path: 'modules/exporting.src.js', mode: 'legacy' })
  })

  it('delegates explicit and detected esbuild plus Dashboards directly to builder', async () => {
    for (const [path, detected, mode, output] of [
      ['/master/highcharts.js?esbuild', false, 'esbuild', 'highcharts.src.js'],
      ['/master/highcharts.js', true, 'esbuild', 'highcharts.src.js'],
      ['/feature/foo/dashboards/dashboards.js', false, 'dashboards', 'dashboards.js']
    ]) {
      const clients = services(detected)
      await request(createRouter({ ...clients, disableRateLimit: true }), path)
      expect(clients.downloader.request.called).to.equal(false)
      expect(clients.builder.request.firstCall.args[1].body).to.include({ mode, path: output })
    }
  })

  it('maps queue-full from downloader and builder to 202 and preserves service errors', async () => {
    const cases = [
      ['downloader', new ServiceError('QUEUE_FULL', 'download queue full', 503)],
      ['builder', new ServiceError('QUEUE_FULL', 'build queue full', 503)],
      ['builder', new ServiceError('INVALID_BUILD', 'Could not assemble this file.', 400)],
      ['downloader', new ServiceError('UPSTREAM_TIMEOUT', 'GitHub request timed out', 504)]
    ]
    for (const [target, error] of cases) {
      const clients = services(target === 'builder')
      clients[target].request.rejects(error)
      const result = await request(createRouter({ ...clients, disableRateLimit: true }), '/master/highcharts.js')
      expect(result.status).to.equal(error.code === 'QUEUE_FULL' ? 202 : error.status)
      expect(result.body).to.equal(error.message)
    }
  })

  it('maps missing refs and GitHub rate limits to the existing public contract', async () => {
    const missing = services()
    missing.downloader.json.rejects(new ServiceError('REF_NOT_FOUND', 'Ref was not found', 404))
    expect(await request(createRouter({ ...missing, disableRateLimit: true }), '/missing/highcharts.js')).to.include({ status: 200, body: 'Not found' })

    const limited = services()
    const reset = Math.floor(Date.now() / 1000) + 60
    limited.downloader.json.rejects(new ServiceError('RATE_LIMITED', 'GitHub returned 403', 403, {
      rateLimitLimit: '5000',
      rateLimitRemaining: '0',
      rateLimitReset: String(reset)
    }))
    const result = await request(createRouter({ ...limited, disableRateLimit: true }), '/master/highcharts.js')
    expect(result).to.include({ status: 429, body: 'GitHub API rate limit exceeded. Please try again later.' })
    expect(result.headers).to.include({
      'cache-control': 'no-store',
      'x-github-ratelimit-limit': '5000',
      'x-github-ratelimit-remaining': '0',
      'x-github-ratelimit-reset': String(reset)
    })
    expect(Number(result.headers['retry-after'])).to.be.within(0, 60)
  })

  it('fans forced cleanup out to both services', async () => {
    const clients = services()
    clients.downloader.json.withArgs('/v1/cleanup').resolves({ removed: ['source'] })
    const result = await request(createRouter({ ...clients, disableRateLimit: true }), '/cleanup?true')
    expect(result).to.include({ status: 200, body: '[]' })
    expect(clients.downloader.json.calledWith('/v1/cleanup', { method: 'POST', body: { force: false } })).to.equal(true)
    expect(clients.builder.json.calledWith('/v1/cleanup', { method: 'POST', body: { force: false } })).to.equal(true)
  })

  it('only inspects cache files for canonical commit SHAs', async () => {
    const router = createRouter({ ...services(), disableRateLimit: true })
    for (const commit of ['../config.json', `${SHA}/../../config.json`, SHA.slice(0, 39), SHA.toUpperCase()]) {
      const result = await request(router, `/files?commit=${encodeURIComponent(commit)}`)
      expect(result.status).to.equal(400)
    }

    const result = await request(router, `/files?commit=${SHA}`)
    expect(result).to.include({ status: 200, body: 'no output folder found for this commit' })
  })

  it('does not expose the legacy header-authorized removal endpoint', async () => {
    const result = await request(createRouter({ ...services(), disableRateLimit: true }), `/${SHA}`, {
      method: 'DELETE',
      headers: { 'User-Agent': 'curl/8.0', Referer: 'highcharts.local' }
    })
    expect(result.status).to.equal(404)
  })

  it('keeps webhook validation local and side-effect free', async () => {
    const clients = services()
    const result = await request(createRouter({ ...clients, disableRateLimit: true }), '/update', { method: 'POST', headers: { 'User-Agent': 'GitHub-Hookshot/0a3a2d2' } })
    expect(result).to.include({ status: 200, body: 'OK' })
    expect(clients.downloader.json.called).to.equal(false)
    expect(clients.builder.request.called).to.equal(false)
  })

  it('validates webhooks with the non-empty environment secret before config', async () => {
    const clients = services()
    const body = JSON.stringify({ ref: 'refs/heads/master' })
    process.env.WEBHOOK_SECRET = 'environment-secret'
    const signature = secret => `sha1=${createHmac('sha1', secret).update(body).digest('hex')}`

    const valid = await request(createRouter({ ...clients, disableRateLimit: true }), '/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature': signature(process.env.WEBHOOK_SECRET) },
      body
    })
    const invalid = await request(createRouter({ ...clients, disableRateLimit: true }), '/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature': signature(secureToken) },
      body
    })

    expect(valid).to.include({ status: 200, body: 'OK' })
    expect(invalid).to.include({ status: 200, body: 'Not found' })
  })

  it('falls back to the config webhook secret for an empty environment value', async () => {
    const clients = services()
    const body = JSON.stringify({ ref: 'refs/heads/master' })
    process.env.WEBHOOK_SECRET = ''
    const signature = `sha1=${createHmac('sha1', secureToken).update(body).digest('hex')}`
    const result = await request(createRouter({ ...clients, disableRateLimit: true }), '/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature': signature },
      body
    })

    expect(result).to.include({ status: 200, body: 'OK' })
  })
})
