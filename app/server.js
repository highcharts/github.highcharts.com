'use strict'

const config = require('../config.json')
const { X509Certificate } = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const { bodyJSONParser, clientErrorHandler, logErrors, setConnectionAborted } = require('./middleware.js')
const { parseOpsConfig } = require('./ops/config')
const { createOpsConsoleRouter } = require('./ops/console-router')
const router = require('./router.js')
const express = require('express')
const { join } = require('node:path')

function createApp (options = {}) {
  const app = express()
  app.use('/_ops', createOpsConsoleRouter(options.ops))
  app.use(setConnectionAborted)
  app.use(bodyJSONParser)
  app.use((req, res, next) => {
    const noop = () => {}
    req.socket?.on('error', noop)
    res.socket?.on('error', noop)
    next()
  })
  app.use(options.router || router)
  app.use(clientErrorHandler)
  app.use(logErrors)
  return app
}

const APP = createApp()

function start () {
  const { publicServer, opsServer, opsConfig } = createServers({ app: APP })
  publicServer.listen(process.env.PORT || config.port || 80)
  if (opsServer) opsServer.listen(opsConfig.mtls.port)
  return publicServer
}

function createServers ({ env = process.env, app, readFile = fs.readFileSync } = {}) {
  const opsConfig = parseOpsConfig(env)
  app = app || createApp({ ops: { env } })
  const publicServer = http.createServer(app)
  if (!opsConfig.enabled || opsConfig.protocol === 'http') return { publicServer, opsServer: null, opsConfig }

  const { keyPath, certPath, caPath } = opsConfig.mtls
  const ca = readFile(caPath)
  if (!new X509Certificate(ca).ca) throw new Error('Invalid OPS_CONSOLE_MTLS_CA_PATH: certificate is not a CA')
  const opsServer = https.createServer({
    key: readFile(keyPath),
    cert: readFile(certPath),
    ca,
    requestCert: true,
    rejectUnauthorized: true
  }, app)
  return { publicServer, opsServer, opsConfig }
}

if (require.main === module || require.main?.filename === join(__dirname, '../server.js')) start()

module.exports = { createApp, createServers, default: APP, start }
