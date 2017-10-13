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
  isJSON
} = require('./utilities.js')
const app = express()
const port = process.env.PORT || config.port || 80

const bodyJSONParser = (req, res, next) => {
  let rawBody = ''
  req.on('data', chunk => {
    rawBody += chunk
  })
  req.on('end', () => {
    if (isJSON(rawBody)) {
      req.body = JSON.parse(rawBody)
    }
    next()
  })
}

console.log('Listening to port: ' + port)
app.use(bodyJSONParser)
app.use('/', router) // Register router
app.listen(port) // Start server
