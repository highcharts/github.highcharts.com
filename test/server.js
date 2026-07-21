'use strict'

const { expect } = require('chai')
const { randomBytes } = require('node:crypto')
const http = require('node:http')
const https = require('node:https')
const fs = require('node:fs')
const { join } = require('node:path')
const { describe, it } = require('mocha')
const { createTokenVerifier } = require('../app/ops/config')
const { createApp, createServers } = require('../app/server')
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

  it('creates only the public listener when disabled or in explicit HTTP loopback mode', () => {
    expect(createServers({ env: {}, app: () => {} }).opsServer).to.equal(null)
    const token = randomBytes(32).toString('base64url')
    const env = {
      OPS_CONSOLE_ENABLED: 'true',
      OPS_CONSOLE_TOKEN_VERIFIER: createTokenVerifier(token),
      OPS_CONSOLE_ORIGIN: 'http://127.0.0.1:8080',
      OPS_CONSOLE_ALLOW_HTTP_LOOPBACK: 'true'
    }
    expect(createServers({ env, app: () => {} }).opsServer).to.equal(null)
  })

  it('fails before listening for unreadable or invalid mTLS material', () => {
    const env = mtlsEnv()
    const handler = (request, response) => response.end('OK')
    const invalid = join(__dirname, '../app/server.js')
    const missing = join(__dirname, 'fixtures/mtls/missing.pem')

    expect(() => createServers({ env: { ...env, OPS_CONSOLE_MTLS_CA_PATH: missing }, app: handler })).to.throw()
    expect(() => createServers({
      env,
      app: handler,
      readFile: path => {
        if (path === env.OPS_CONSOLE_MTLS_CA_PATH) throw Object.assign(new Error('unreadable test CA'), { code: 'EACCES' })
        return fs.readFileSync(path)
      }
    })).to.throw('unreadable test CA')
    for (const name of ['OPS_CONSOLE_MTLS_KEY_PATH', 'OPS_CONSOLE_MTLS_CERT_PATH', 'OPS_CONSOLE_MTLS_CA_PATH']) {
      expect(() => createServers({ env: { ...env, [name]: invalid }, app: handler })).to.throw()
    }
    expect(() => createServers({
      env: { ...env, OPS_CONSOLE_MTLS_KEY_PATH: fixture('client.key') },
      app: handler
    })).to.throw()
  })

  it('serves public HTTP separately and admits console HTTPS only after trusted client mTLS', async () => {
    const token = randomBytes(32).toString('base64url')
    const env = mtlsEnv(token)
    const events = []
    const app = createApp({ ops: { env, log: event => events.push(event) } })
    const { publicServer, opsServer } = createServers({ env, app })
    expect(opsServer.requestCert).to.equal(true)
    expect(opsServer.rejectUnauthorized).to.equal(true)
    await Promise.all([listen(publicServer), listen(opsServer)])

    try {
      const publicHealth = await networkRequest(http, { port: publicServer.address().port, path: '/health' })
      expect(publicHealth).to.include({ status: 200, body: 'OK' })

      const publicConsole = await networkRequest(http, { port: publicServer.address().port, path: '/_ops/login' })
      expect(publicConsole.status).to.equal(400)
      expect(JSON.parse(publicConsole.body).error.code).to.equal('INVALID_REQUEST_CONTEXT')

      const tls = {
        port: opsServer.address().port,
        path: '/_ops/login',
        ca: fs.readFileSync(fixture('ca.crt')),
        cert: fs.readFileSync(fixture('client.crt')),
        key: fs.readFileSync(fixture('client.key')),
        servername: 'localhost'
      }
      const consoleResponse = await networkRequest(https, {
        ...tls,
        headers: {
          Forwarded: 'for=203.0.113.9;proto=http',
          'X-Forwarded-For': '198.51.100.8',
          'X-Forwarded-Proto': 'http'
        }
      })
      expect(consoleResponse.status).to.equal(200)
      expect(consoleResponse.body).to.include('<form id="login-form">')

      const login = await networkRequest(https, {
        ...tls,
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
      const rejectedCache = await networkRequest(https, {
        ...tls,
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

      await expectNetworkFailure(networkRequest(https, {
        port: opsServer.address().port,
        path: '/_ops/login',
        ca: tls.ca,
        servername: 'localhost'
      }))
      await expectNetworkFailure(networkRequest(https, {
        ...tls,
        cert: fs.readFileSync(fixture('untrusted-client.crt')),
        key: fs.readFileSync(fixture('untrusted-client.key'))
      }))
      await expectNetworkFailure(networkRequest(http, { port: opsServer.address().port, path: '/_ops/login' }))
    } finally {
      await Promise.all([close(publicServer), close(opsServer)])
    }
  })
})

function fixture (name) {
  return join(__dirname, 'fixtures/mtls', name)
}

function mtlsEnv (token = randomBytes(32).toString('base64url')) {
  return {
    OPS_CONSOLE_ENABLED: 'true',
    OPS_CONSOLE_TOKEN_VERIFIER: createTokenVerifier(token),
    OPS_CONSOLE_ORIGIN: 'https://localhost:8443',
    OPS_CONSOLE_MTLS_KEY_PATH: fixture('server.key'),
    OPS_CONSOLE_MTLS_CERT_PATH: fixture('server.crt'),
    OPS_CONSOLE_MTLS_CA_PATH: fixture('ca.crt')
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

async function expectNetworkFailure (promise) {
  let error
  try { await promise } catch (failure) { error = failure }
  expect(error).to.be.instanceOf(Error)
}

function networkRequest (protocol, options) {
  return new Promise((resolve, reject) => {
    const { body, ...requestOptions } = options
    const outgoing = protocol.request({ host: '127.0.0.1', method: 'GET', ...requestOptions }, response => {
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
