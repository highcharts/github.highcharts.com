'use strict'

const express = require('express')
const crypto = require('node:crypto')
const config = require('./config.json')
const { createBuilderService } = require('./app/builder-service')

function createApp (options = {}) {
  const token = options.token === undefined ? process.env.INTERNAL_SERVICE_TOKEN : options.token
  if (!token) throw new Error('INTERNAL_SERVICE_TOKEN is required')

  const app = express()
  const service = options.service || createBuilderService(options)
  const expectedAuthorization = Buffer.from(`Bearer ${token}`)
  app.locals.service = service
  app.use(express.json())
  app.get('/health', (req, res) => res.json({ status: 'ok' }))
  app.use('/v1', (req, res, next) => {
    const authorization = Buffer.from(req.get('authorization') || '')
    if (authorization.length !== expectedAuthorization.length || !crypto.timingSafeEqual(authorization, expectedAuthorization)) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } })
    next()
  })
  app.post('/v1/build', asyncRoute(async (req, res) => {
    const result = await service.build(req.body)
    res.set('X-Built-With', result.builtWith)
    res.set('X-Build-Path', result.path)
    result.stream.on('error', error => res.destroy(error))
    result.stream.pipe(res)
  }))
  app.post('/v1/cleanup', asyncRoute(async (req, res) => {
    res.json({ removed: await service.cleanup(Boolean(req.body && req.body.force)) })
  }))
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error)
    if (error.retryAfter) res.set('Retry-After', error.retryAfter)
    if (error.rateLimitRemaining) res.set('X-GitHub-RateLimit-Remaining', error.rateLimitRemaining)
    if (error.rateLimitReset) res.set('X-GitHub-RateLimit-Reset', error.rateLimitReset)
    res.status(error.status || 500).json({ error: { code: error.code || 'INTERNAL_ERROR', message: error.message } })
  })
  return app
}

function asyncRoute (handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
}

function start () {
  const app = createApp()
  const interval = Number(process.env.BUILDER_CLEAN_INTERVAL || config.builderCleanInterval || 2 * 60 * 1000)
  const timer = setInterval(() => app.locals.service.cleanup().catch(console.error), interval)
  timer.unref()
  return app.listen(Number(process.env.BUILDER_PORT || config.builderPort || 8082))
}

if (require.main === module) start()

module.exports = { createApp, start }
