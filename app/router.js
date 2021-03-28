/**
 * Express router.
 * Takes care of serving any result, and handling of errors.
 * @author Jon Arild Nygard
 * @todo Add license
 */

'use strict'

// Import dependencies, sorted by path name.
const {
  catchAsyncErrors,
  handlerDefault,
  handlerHealth,
  handlerIcon,
  handlerIndex,
  handlerRobots
} = require('./handlers.js')
const { Router } = require('express')

// Middleware
const rateLimit = require('express-rate-limit')
const slowDown = require('express-slow-down')
const { log } = require('./utilities')

// Constants
const ROUTER = Router()

// Register handlers to the router
ROUTER.get('/health', catchAsyncErrors(handlerHealth))
ROUTER.get('/favicon.ico', catchAsyncErrors(handlerIcon))
ROUTER.get('/robots.txt', catchAsyncErrors(handlerRobots))
ROUTER.get('/', catchAsyncErrors(handlerIndex))

const skip = req => {
  // allow requests with allowed referers
  const referer = req.get('Referer')
  const allowedReferer = referer
    ? ['highcharts.local', 'highcharts.com'].some((url) => referer.includes(url))
    : false

  if (allowedReferer) {
    log(1, `skipping rate limiter for referer ${referer}`)
    return true
  }
  return false
}

// Separate limit for each file requested
const keyGenerator = (req) => {
  return req.ip + req.baseUrl
}

// Slow down after 15 requests
// Delay is cumulative up to 2s
ROUTER.use('*', slowDown({
  windowMs: 15 * 60 * 1000,
  delayAfter: 15,
  delayMs: 500,
  keyGenerator,
  skip
}))

// limit after 60 requests (per file) in a 15 minute period
ROUTER.use('*', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: `github.highcharts.com is intended for testing only.
Use code.highcharts.com for production environments`,
  keyGenerator,
  skip
}))

ROUTER.get('*', catchAsyncErrors(handlerDefault))

// Export the router
module.exports = ROUTER
