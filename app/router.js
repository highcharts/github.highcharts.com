/**
 * Setup of url routing, takes care of serving any result, and handling of errors.
 * @author Jon Arild Nygard
 */
'use strict'
const router = require('express').Router()
const {
  catchAsyncErrors,
  handlerDefault,
  handlerHealth,
  handlerIcon,
  handlerIndex,
  handlerRobots,
  handlerUpdate
} = require('./handlers.js')

router.get('/health', catchAsyncErrors(handlerHealth))
router.post('/update', catchAsyncErrors(handlerUpdate))
router.get('/favicon.ico', catchAsyncErrors(handlerIcon))
router.get('/robots.txt', catchAsyncErrors(handlerRobots))
router.get('/', catchAsyncErrors(handlerIndex))
router.get('*', catchAsyncErrors(handlerDefault))

module.exports = router
