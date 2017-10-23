/**
 * Server application.
 * Fires up a server using ExpressJS, and registers routers, and starts listening to a port.
 * All processes related to startup belongs in this script.
 * @author Jon Arild Nygard
 * @todo Add license
 */
'use strict'
const express = require('express')
const router = require('./router.js')
const config = require('../config.json')
const {
  formatDate
} = require('./filesystem.js')
const {
  bodyJSONParser,
  clientErrorHandler,
  logErrors,
  setConnectionAborted
} = require('./middleware.js')
const app = express()
const port = process.env.PORT || config.port || 80
const date = formatDate(new Date())
const content = [
  'Starting server',
  'Port: ' + port,
  'Date: ' + date,
  ''
]
console.log(content.join('\n'))

app.use(setConnectionAborted)
app.use('/', router) // Register router
app.use(bodyJSONParser)
app.use(clientErrorHandler)
app.use(logErrors)
app.listen(port) // Start server
