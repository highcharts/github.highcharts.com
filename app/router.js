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
  handlerUpdate
} = require('./handlers.js')
const { Router } = require('express')

// Constants
const ROUTER = Router()

// Register handlers to the router
ROUTER.get('/health', catchAsyncErrors(handlerHealth))
ROUTER.post('/update', catchAsyncErrors(handlerUpdate))
ROUTER.get('/favicon.ico', catchAsyncErrors(handlerIcon))
ROUTER.get('/robots.txt', catchAsyncErrors(handlerRobots))
ROUTER.get('/', catchAsyncErrors(handlerIndex))
ROUTER.get('*', catchAsyncErrors(handlerDefault))

// Export the router
module.exports = ROUTER
