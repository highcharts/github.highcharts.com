const {
  isJSON
} = require('./utilities.js')
const {
  response
} = require('./message.json')
const {
  debug,
  formatDate
} = require('./filesystem.js')

const bodyJSONParser = (req, res, next) => {
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

const setConnectionAborted = (req, res, next) => {
  req.connectionAborted = false
  req.on('close', () => {
    req.connectionAborted = true
  })
  next()
}

const clientErrorHandler = (err, req, res, next) => {
  res.status(response.error.status).send(response.error.body)
  next(err)
}
/**
 * Handle any errors that is catched in the routers.
 * Respond with a proper message to the requester.
 * @param  {Error} err Error object
 * @param  {object} res Express response object.
 * @return {undefined}
 */
const logErrors = (err, req, res, next) => {
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

module.exports = {
  bodyJSONParser,
  clientErrorHandler,
  logErrors,
  setConnectionAborted
}
