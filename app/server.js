'use strict'

const config = require('../config.json')
const http = require('node:http')
const { bodyJSONParser, clientErrorHandler, logErrors, setConnectionAborted } = require('./middleware.js')
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
  return http.createServer(APP).listen(process.env.PORT || config.port || 80)
}

if (require.main === module || require.main?.filename === join(__dirname, '../server.js')) start()

module.exports = { createApp, default: APP, start }
