'use strict'

const { expect } = require('chai')
const { randomBytes } = require('node:crypto')
const http = require('node:http')
const fs = require('node:fs')
const { join } = require('node:path')
const { describe, it } = require('mocha')
const { createTokenVerifier } = require('../app/ops/config')
const { createApp } = require('../app/server')
const { createRouter } = require('../app/router')

describe('public server', () => {
  it('serves health without starting a listener or calling services', async () => {
    const unavailable = () => { throw new Error('service called') }
    const app = createApp({
      ops: { env: {}, log: () => {} },
      router: createRouter({ downloader: { json: unavailable }, builder: {}, disableRateLimit: true })
    })
    const response = await request(app, '/health')
    expect(response).to.include({ status: 200, body: 'OK' })
  })

  it('has no public build registry, periodic cleanup, or server-handler cycle', () => {
    const server = fs.readFileSync(join(__dirname, '../app/server.js'), 'utf8')
    const handlers = fs.readFileSync(join(__dirname, '../app/handlers.js'), 'utf8')
    expect(server).not.to.include('typescriptJobs')
    expect(server).not.to.include('setInterval')
    expect(handlers).not.to.include("require('./server.js')")
  })

  it('serves an external HTTPS console origin on the single plain HTTP listener', async () => {
    const token = randomBytes(32).toString('base64url')
    const env = enabledEnv(token, 'https://ops.example.test')
    const events = []
    const app = createApp({ ops: { env, log: event => events.push(event) } })
    const server = http.createServer(app)
    await listen(server)

    try {
      const port = server.address().port
      const publicHealth = await networkRequest({ port, path: '/health' })
      expect(publicHealth).to.include({ status: 200, body: 'OK' })

      const consoleResponse = await networkRequest({
        port,
        path: '/_ops/login',
        headers: {
          Forwarded: 'for=203.0.113.9;proto=http',
          'X-Forwarded-For': '198.51.100.8',
          'X-Forwarded-Proto': 'http'
        }
      })
      expect(consoleResponse.status).to.equal(200)
      expect(consoleResponse.body).to.include('<form id="login-form">')

      const login = await networkRequest({
        port,
        method: 'POST',
        path: '/_ops/api/v1/session',
        headers: {
          Origin: env.OPS_CONSOLE_ORIGIN,
          'Content-Type': 'application/json',
          'X-Forwarded-For': '198.51.100.8',
          'X-Forwarded-Proto': 'http'
        },
        body: JSON.stringify({ token })
      })
      expect(login.status).to.equal(201)
      expect(login.headers['set-cookie'][0]).to.match(/^__Host-hc-ops=.*; Secure;/)
      const session = JSON.parse(login.body)
      const rejectedCache = await networkRequest({
        port,
        method: 'POST',
        path: '/_ops/api/v1/cache-operations',
        headers: {
          Cookie: login.headers['set-cookie'][0].split(';', 1)[0],
          Origin: env.OPS_CONSOLE_ORIGIN,
          'Content-Type': 'application/json',
          'X-Ops-CSRF': session.csrfToken,
          Forwarded: 'for=203.0.113.9;proto=http',
          'X-Forwarded-For': '198.51.100.8',
          'X-Forwarded-Proto': 'http'
        },
        body: JSON.stringify({ operation: 'not-an-operation', targets: ['builder'] })
      })
      expect(rejectedCache.status).to.equal(400)
      expect(events.find(event => event.action === 'cache_operation')).to.include({ source: null, dispatchStatus: 'not_dispatched' })
    } finally {
      await close(server)
    }
  })

  it('retains explicit HTTP loopback mode without a Secure cookie', async () => {
    const token = randomBytes(32).toString('base64url')
    const env = enabledEnv(token, 'http://127.0.0.1:8080', { OPS_CONSOLE_ALLOW_HTTP_LOOPBACK: 'true' })
    const server = http.createServer(createApp({ ops: { env, log: () => {} } }))
    await listen(server)
    try {
      const login = await networkRequest({
        port: server.address().port,
        method: 'POST',
        path: '/_ops/api/v1/session',
        headers: { Origin: env.OPS_CONSOLE_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      })
      expect(login.status).to.equal(201)
      expect(login.headers['set-cookie'][0]).to.match(/^ghhc-console-dev=/)
      expect(login.headers['set-cookie'][0]).not.to.include('; Secure')
    } finally {
      await close(server)
    }
  })
})

function enabledEnv (token, origin, overrides = {}) {
  return {
    OPS_CONSOLE_ENABLED: 'true',
    OPS_CONSOLE_TOKEN_VERIFIER: createTokenVerifier(token),
    OPS_CONSOLE_ORIGIN: origin,
    ...overrides
  }
}

function listen (server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

function close (server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

function networkRequest (options) {
  return new Promise((resolve, reject) => {
    const { body, ...requestOptions } = options
    const outgoing = http.request({ host: '127.0.0.1', method: 'GET', ...requestOptions }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }))
    })
    outgoing.on('error', reject)
    outgoing.end(body)
  })
}

function request (app, path) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      http.get({ port: server.address().port, path }, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          server.close()
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() })
        })
      }).on('error', reject)
    })
  })
}
