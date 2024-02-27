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
  handlerRobots,
  handlerCleanup,
  handlerFS,
  handlerRemoveFiles,
  handlerUpdate
} = require('./handlers.js')

const { dashboardsHandler } = require('./dashboards')
const { Router } = require('express')

// Middleware
const rateLimit = require('express-rate-limit')
const slowDown = require('express-slow-down')

// Constants
const ROUTER = Router()

// Register handlers to the router
ROUTER.get('/health', catchAsyncErrors(handlerHealth))
ROUTER.get('/favicon.ico', catchAsyncErrors(handlerIcon))
ROUTER.get('/robots.txt', catchAsyncErrors(handlerRobots))
ROUTER.get('/', catchAsyncErrors(handlerIndex))
ROUTER.get('/cleanup', catchAsyncErrors(handlerCleanup))
ROUTER.get('/files', catchAsyncErrors(handlerFS))
ROUTER.delete('/*', catchAsyncErrors(handlerRemoveFiles))
ROUTER.post('/*', catchAsyncErrors(handlerUpdate))

// Separate limit for each file requested
const keyGenerator = (req) => {
  return req.ip + req.baseUrl
}

// Slow down after 15 requests
// Delay is cumulative up to 10s
ROUTER.use('*', slowDown({
  windowMs: 15 * 60 * 1000,
  delayAfter: 15,
  delayMs: (hits) => hits * 500,
  maxDelayMs: 10000,
  keyGenerator
}))

// limit after 60 requests (per file) in a 15 minute period
ROUTER.use('*', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: `github.highcharts.com is intended for testing only.
Use code.highcharts.com for production environments`,
  keyGenerator
}))

// long, shorter, and short commit SHAs
ROUTER.get('/:commit(\\w{40}|\\w{10}|\\w{7})/dashboards/:filepath(*)', dashboardsHandler)

// Otherwise assume branch?
ROUTER.get('/:branch(*)/dashboards/:filepath(*)', dashboardsHandler)

ROUTER.get('*', catchAsyncErrors(handlerDefault))

// Export the router
module.exports = ROUTER
