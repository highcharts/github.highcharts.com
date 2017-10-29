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

/**
 * Register middleware for ExpressJS application
 *
 * Important! The sequence of registering the middleware is crucial when it
 * comes to how it executes. First come first served.
 * 1. Listen for aborted connections
 * 2. Parse request body.
 * 3. Do application routing
 * 4. If an error occurs above, the clientErrorHandler will give the client
 *    a proper response, and pass the error to the next middleware.
 * 5. If an error occurs above the logErrors will log it to the console, with
 *    additional information. It will not pass the error to the next middleware.
 */
app.use(setConnectionAborted)
app.use(bodyJSONParser)
app.use(router)
app.use(clientErrorHandler)
app.use(logErrors)

/**
 * Start the server
 */
app.listen(port)
