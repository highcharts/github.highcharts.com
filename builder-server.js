'use strict'

const express = require('express')
const config = require('./config.json')
const { createBuilderService } = require('./app/builder-service')
const { asyncRoute, observedRoute, requireBearer } = require('./app/ops/http')
const { createInternalOpsRouter } = require('./app/ops/internal-router')

const PUBLIC_ERRORS = {
  ARCHIVE_ERROR: 'Source archive extraction failed',
  DOWNLOADER_ERROR: 'Downloader request failed',
  DOWNLOADER_TIMEOUT: 'Downloader request timed out',
  INVALID_BUILD: 'Build did not produce the requested file',
  INVALID_COMMIT: 'Commit must be a canonical 40-character SHA',
  INVALID_MODE: 'Unknown build mode',
  INVALID_OPTIONS: 'Options must be an object',
  INVALID_PATH: 'Path must be a normalized relative output path',
  QUEUE_FULL: 'Build capacity is unavailable',
  SOURCE_INCOMPLETE: 'Source archive is incomplete'
}

function createApp (options = {}) {
  const token = options.token === undefined ? process.env.INTERNAL_SERVICE_TOKEN : options.token
  if (!token) throw new Error('INTERNAL_SERVICE_TOKEN is required')

  const app = express()
  const service = options.service || createBuilderService(options)
  app.locals.service = service
  app.get('/health', (req, res) => res.json({ status: 'ok' }))
  app.use('/v1', (req, res, next) => {
    try {
      requireBearer(req, token)
    } catch {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } })
    }
    next()
  })
  if (typeof service.snapshot === 'function' && service.cacheManager) {
    app.use(createInternalOpsRouter({ token, service: 'builder', snapshot: service.snapshot, cache: service.cacheManager }))
  }
  app.use(express.json())
  app.post('/v1/build', observedRoute(service, '/v1/build', req => ({ commit: req.body && req.body.commit, buildMode: req.body && req.body.mode }), async (req, res) => {
    const result = await service.build(req.body, { correlationId: req.correlationId })
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
    const code = Object.hasOwn(PUBLIC_ERRORS, error.code) ? error.code : 'INTERNAL_ERROR'
    res.status(code === 'INTERNAL_ERROR' ? 500 : error.status || 500).json({ error: { code, message: PUBLIC_ERRORS[code] || 'An internal error occurred' } })
  })
  return app
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
