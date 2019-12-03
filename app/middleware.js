/**
 * Express middleware functions.
 * All middleware functions used by the server applications belong here.
 * @author Jon Arild Nygard
 * @todo Add license
 */
'use strict'

// Import dependencies, sorted by path name.
const {
  debug,
  formatDate
} = require('./filesystem.js')
const {
  response
} = require('./message.json')
const {
  isJSON
} = require('./utilities.js')

/**
 * If the request body is valid JSON, the it is parsed and the result is set as
 * the property body on the request object.
 *
 * @param {Request} req ExpressJS Request object.
 * @param {Response} res ExpressJS Response object.
 * @param {Function} next Call the next middleware function in the stack.
 */
function bodyJSONParser (req, res, next) {
  req.rawBody = ''
  req.on('data', chunk => {
    // chunk is a buffer, but is converted to a string in the assignment.
    req.rawBody += chunk
  })
  req.on('end', () => {
    if (isJSON(req.rawBody)) {
      req.body = JSON.parse(req.rawBody)
    }
    next()
  })
}

/**
 * Responds to the client with an error status code and a message.
 *
 * @param {Error} err Error object.
 * @param {Request} req ExpressJS Request object.
 * @param {Response} res ExpressJS Response object.
 * @param {Function} next Call the next middleware function in the stack.
 */
function clientErrorHandler (err, req, res, next) {
  res.status(response.error.status).send(response.error.body)
  next(err)
}

/**
 * Output error information to the console to enable debugging.
 * Information includes date, url, and error stacktrace.
 *
 * @param {Error} err Error object.
 * @param {Request} req ExpressJS Request object.
 * @param {Response} res ExpressJS Response object.
 * @param {Function} next Call the next middleware function in the stack.
 */
function logErrors (err, req, res, next) {
  const date = formatDate(new Date())
  const content = [
    'Date: ' + date,
    'URL: ' + req.originalUrl,
    err.stack,
    ''
  ]
  debug(true, content.join('\n'))
  next()
}

/**
 * Listen for the close event on the request object, and sets the property
 * connectionAborted to true on the request object. This is useful to avoid
 * responding to a closed connection.
 *
 * @param {Request} req ExpressJS Request object.
 * @param {Response} res ExpressJS Response object.
 * @param {Function} next Call the next middleware function in the stack.
 */
function setConnectionAborted (req, res, next) {
  req.connectionAborted = false
  req.on('close', () => {
    req.connectionAborted = true
  })
  next()
}

// Export middleware functions
module.exports = {
  bodyJSONParser,
  clientErrorHandler,
  logErrors,
  setConnectionAborted
}
