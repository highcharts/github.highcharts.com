/**
 * Server application.
 * Fires up a server using ExpressJS, and registers routers, and starts listening to a port.
 * All processes related to startup belongs in this script.
 * @author Jon Arild Nygard
 * @todo Add license
 */
'use strict'

// Import dependencies, sorted by path name.
const config = require('../config.json')
const {
  bodyJSONParser,
  clientErrorHandler,
  logErrors,
  setConnectionAborted
} = require('./middleware.js')
const router = require('./router.js')
const { formatDate } = require('./utilities.js')
const express = require('express')

// Constants
const APP = express()
const PORT = process.env.PORT || config.port || 80
const DATE = formatDate(new Date())

// Output status information
console.log(`
Starting server
Port: ${PORT}
Date: ${DATE}
`)

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
APP.use(setConnectionAborted)
APP.use(bodyJSONParser)
APP.use(router)
APP.use(clientErrorHandler)
APP.use(logErrors)

/**
 * Start the server
 */
APP.listen(PORT)
