'use strict'

const express = require('express')
const crypto = require('node:crypto')
const config = require('./config.json')
const { createDownloaderService } = require('./app/downloader-service')

function createApp (options = {}) {
  const token = options.token === undefined ? process.env.INTERNAL_SERVICE_TOKEN : options.token
  if (!token) throw new Error('INTERNAL_SERVICE_TOKEN is required')

  const app = express()
  const service = options.service || createDownloaderService(options)
  const expectedAuthorization = Buffer.from(`Bearer ${token}`)

  app.use(express.json())
  app.locals.service = service
  app.get('/health', (req, res) => res.json({ status: 'ok' }))
  app.use('/v1', (req, res, next) => {
    const authorization = Buffer.from(req.get('authorization') || '')
    if (authorization.length !== expectedAuthorization.length || !crypto.timingSafeEqual(authorization, expectedAuthorization)) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } })
    }
    next()
  })
  app.post('/v1/resolve', asyncRoute(async (req, res) => {
    res.json(await service.resolveRef(req.body && req.body.ref))
  }))
  app.get('/v1/files/:commit/*', asyncRoute(async (req, res) => {
    const stream = await service.openFile(req.params.commit, req.params[0])
    res.set('Cache-Control', 'public, max-age=31536000, immutable')
    stream.on('error', error => res.destroy(error))
    stream.pipe(res)
  }))
  app.get('/v1/sources/:commit.tar.gz', asyncRoute(async (req, res, next) => {
    const tar = await service.archive(req.params.commit)
    let stderr = ''
    tar.stderr.on('data', chunk => { stderr += chunk })
    tar.on('error', next)
    tar.on('close', code => {
      if (code && !res.headersSent) next(new Error(stderr || `tar exited with ${code}`))
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
    res.status(error.status || 500).json({
      error: { code: error.code || 'INTERNAL_ERROR', message: error.message }
    })
  })
  return app
}

function asyncRoute (handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
}

function start () {
  const app = createApp()
  const interval = Number(process.env.DOWNLOADER_CLEAN_INTERVAL || config.downloaderCleanInterval || 2 * 60 * 1000)
  const timer = setInterval(() => app.locals.service?.cleanup().catch(console.error), interval)
  timer.unref()
  return app.listen(Number(process.env.DOWNLOADER_PORT || config.downloaderPort || 8081))
}

if (require.main === module) start()

module.exports = { createApp, start }
