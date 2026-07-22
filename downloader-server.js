'use strict'

const express = require('express')
const config = require('./config.json')
const { createDownloaderService } = require('./app/downloader-service')
const { asyncRoute, observedRoute, requireBearer } = require('./app/ops/http')
const { createInternalOpsRouter } = require('./app/ops/internal-router')

const PUBLIC_ERRORS = {
  FILE_NOT_FOUND: 'File was not found',
  INVALID_COMMIT: 'Commit must be a 40-character SHA',
  INVALID_PATH: 'Unsafe file path',
  QUEUE_FULL: 'Download capacity is unavailable',
  RATE_LIMITED: 'GitHub rate limit is exhausted',
  REF_NOT_FOUND: 'Ref was not found',
  SOURCE_INCOMPLETE: 'Source tree is incomplete',
  UPSTREAM_ERROR: 'GitHub request failed',
  UPSTREAM_TIMEOUT: 'GitHub request timed out'
}

function createApp (options = {}) {
  const token = options.token === undefined ? process.env.INTERNAL_SERVICE_TOKEN : options.token
  if (!token) throw new Error('INTERNAL_SERVICE_TOKEN is required')

  const app = express()
  const service = options.service || createDownloaderService(options)

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
    app.use(createInternalOpsRouter({ token, service: 'downloader', snapshot: service.snapshot, cache: service.cacheManager }))
  }
  app.use(express.json())
  app.post('/v1/resolve', observedRoute(service, '/v1/resolve', req => ({ resource: req.body && req.body.ref }), async (req, res) => {
    res.json(await service.resolveRef(req.body && req.body.ref, { correlationId: req.correlationId }))
  }))
  app.get('/v1/files/:commit/*', observedRoute(service, '/v1/files/:commit/*', req => ({ commit: req.params.commit, resource: req.params[0] }), async (req, res) => {
    const stream = await service.openFile(req.params.commit, req.params[0], { correlationId: req.correlationId })
    res.set('Cache-Control', 'public, max-age=31536000, immutable')
    stream.on('error', error => res.destroy(error))
    stream.pipe(res)
  }))
  app.get('/v1/sources/:commit.tar.gz', observedRoute(service, '/v1/sources/:commit.tar.gz', req => ({ commit: req.params.commit }), async (req, res, next) => {
    const tar = await service.archive(req.params.commit, { correlationId: req.correlationId })
    tar.stderr.resume()
    tar.on('error', next)
    tar.on('close', code => {
      if (code && !res.headersSent) next(new Error('Archive generation failed'))
    })
    res.type('application/gzip')
    res.set('Cache-Control', 'public, max-age=31536000, immutable')
    tar.stdout.pipe(res)
  }))
  app.post('/v1/cleanup', asyncRoute(async (req, res) => {
    res.json({ removed: await service.cleanup(Boolean(req.body && req.body.force)) })
  }))
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error)
    if (error.rateLimitLimit != null) res.set('X-GitHub-RateLimit-Limit', String(error.rateLimitLimit))
    if (error.rateLimitRemaining != null) res.set('X-GitHub-RateLimit-Remaining', String(error.rateLimitRemaining))
    if (error.rateLimitReset != null) res.set('X-GitHub-RateLimit-Reset', String(error.rateLimitReset))
    const code = Object.hasOwn(PUBLIC_ERRORS, error.code) ? error.code : 'INTERNAL_ERROR'
    res.status(code === 'INTERNAL_ERROR' ? 500 : error.status || 500).json({
      error: { code, message: PUBLIC_ERRORS[code] || 'An internal error occurred' }
    })
  })
  return app
}

function start () {
  const app = createApp()
  const interval = Number(process.env.DOWNLOADER_CLEAN_INTERVAL || config.downloaderCleanInterval || 2 * 60 * 1000)
  const timer = setInterval(() => app.locals.service?.cleanup().catch(() => console.error('Downloader cleanup failed')), interval)
  timer.unref()
  return app.listen(Number(process.env.DOWNLOADER_PORT || config.downloaderPort || 8081))
}

if (require.main === module) start()

module.exports = { createApp, start }
