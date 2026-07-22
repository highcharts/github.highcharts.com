'use strict'

const { Readable } = require('node:stream')
const { randomUUID } = require('node:crypto')
const { pipeline } = require('node:stream/promises')
const { join, posix } = require('node:path')
const { readFile } = require('node:fs/promises')
const express = require('express')
const rateLimit = require('express-rate-limit')
const slowDown = require('express-slow-down')
const config = require('../config.json')
const { version } = require('../package.json')
const { createServiceClient, ServiceError } = require('./service-client')
const { Telemetry } = require('./ops/telemetry')
const { getBranch, getFile, getFileForEsbuild, getType } = require('./interpreter.js')
const {
  catchAsyncErrors,
  handlerFS,
  handlerHealth,
  handlerIcon,
  handlerRobots,
  handlerUpdate,
  setPublicHeaders
} = require('./handlers.js')

const indexPath = join(__dirname, '..', 'static', 'index.html')
const PUBLIC_ROUTE = '/:ref/*'
const PUBLIC_OPERATION = 'public_file_delivery'
const FAILURE_SUMMARIES = {
  FILE_NOT_FOUND: 'File was not found',
  INVALID_BUILD: 'Build request was invalid',
  QUEUE_FULL: 'Service capacity is unavailable',
  RATE_LIMITED: 'GitHub rate limit is exhausted',
  REF_NOT_FOUND: 'Ref was not found',
  SERVICE_TIMEOUT: 'Internal service timed out',
  SERVICE_UNAVAILABLE: 'Internal service is unavailable',
  UPSTREAM_TIMEOUT: 'GitHub request timed out'
}
const SHA_PATTERN = /^[a-f0-9]{40}$/

function createRouter (options = {}) {
  const router = express.Router()
  const opsConsoleEnabled = options.opsConsoleEnabled ?? process.env.OPS_CONSOLE_ENABLED === 'true'
  const token = options.token ?? process.env.INTERNAL_SERVICE_TOKEN
  const downloader = options.downloader || createServiceClient({
    baseURL: process.env.DOWNLOADER_URL || config.downloaderURL,
    token,
    timeout: process.env.PUBLIC_DOWNLOADER_TIMEOUT || config.publicDownloaderTimeout || 5000
  })
  const builder = options.builder || createServiceClient({
    baseURL: process.env.BUILDER_URL || config.builderURL || 'http://127.0.0.1:8082',
    token,
    timeout: process.env.PUBLIC_BUILDER_TIMEOUT || config.publicBuilderTimeout || 30000
  })
  const now = options.now || Date.now
  const telemetry = options.telemetry || new Telemetry({
    service: 'router',
    operations: [PUBLIC_OPERATION],
    routes: [PUBLIC_ROUTE],
    failureSummaries: FAILURE_SUMMARIES,
    now
  })

  router.use((req, res, next) => {
    req.correlationId = randomUUID()
    res.set('X-Correlation-ID', req.correlationId)
    next()
  })

  router.get('/health', catchAsyncErrors(handlerHealth))
  router.get('/favicon.ico', catchAsyncErrors(handlerIcon))
  router.get('/robots.txt', catchAsyncErrors(handlerRobots))
  router.get('/cleanup', catchAsyncErrors(async (req, res) => {
    if (opsConsoleEnabled) return res.sendStatus(404)
    if (!req.url.includes('?true')) return send(res, req, 400, 'Something went wrong. Please note that this service is for debugging only. Use our <a href="http://code.highcharts.com">official CDN</a> in production.')
    const body = { force: false }
    const [, result] = await Promise.all([
      downloader.json('/v1/cleanup', { method: 'POST', body, correlationId: req.correlationId }),
      builder.json('/v1/cleanup', { method: 'POST', body, correlationId: req.correlationId })
    ])
    return send(res, req, 200, result.removed)
  }))
  router.get('/files', catchAsyncErrors(handlerFS))
  router.post('/*', catchAsyncErrors(handlerUpdate))
  router.get('/', catchAsyncErrors(async (_, res) => {
    res.type('html').send((await readFile(indexPath, 'utf8')).replace('{{APP_VERSION}}', version))
  }))
  router.use((req, res, next) => {
    let path
    try { path = posix.normalize(decodeURIComponent(req.path)) } catch { return next() }
    return path === '/ops' || path.startsWith('/ops/') ? res.sendStatus(404) : next()
  })
  router.use(express.static('static'))

  if (!options.disableRateLimit) {
    const keyGenerator = req => (req.headers['CF-Connecting-IP'] ?? req.ip) + req.baseUrl
    router.use('*', slowDown({ windowMs: 15 * 60 * 1000, delayAfter: 15, delayMs: hits => hits * 500, maxDelayMs: 10000, keyGenerator }))
    router.use('*', rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      message: 'github.highcharts.com is intended for testing only.\nUse code.highcharts.com for production environments',
      keyGenerator
    }))
  }

  router.get('/:commit(\\w{40}|\\w{10}|\\w{7})/dashboards/:filepath(*)', catchAsyncErrors(proxyFile))
  router.get('/:branch(*)/dashboards/:filepath(*)', catchAsyncErrors(proxyFile))
  router.get('*', catchAsyncErrors(proxyFile))

  async function proxyFile (req, res) {
    const controller = new AbortController()
    const abort = () => controller.abort()
    req.once('aborted', abort)
    res.once('close', () => { if (!res.writableEnded) abort() })

    let rate = {}
    let traceStarted = false
    let failure
    const startTrace = (commit = null, buildMode = null, resource = req.path) => {
      if (traceStarted) {
        const request = telemetry.active.get(req.correlationId)?.request
        if (request && /^[0-9a-f]{40}$/.test(commit || '')) request.commit = commit
        if (request && ['legacy', 'dashboards', 'esbuild', 'static'].includes(buildMode)) request.buildMode = buildMode
        return
      }
      traceStarted = true
      telemetry.startTrace({ correlationId: req.correlationId, method: req.method, route: PUBLIC_ROUTE, commit, resource, buildMode })
      telemetry.startSpan(req.correlationId, PUBLIC_OPERATION)
    }
    startTrace()
    try {
      const originalBranch = await getBranch(req.path)
      const explicitEsbuild = Object.hasOwn(req.query, 'esbuild')
      const canonicalSha = SHA_PATTERN.test(originalBranch)
      const skipEsbuild = explicitEsbuild || (isExplicitRef(req.url, originalBranch) && !canonicalSha)
      const resolved = await observeDependency(telemetry, 'downloader', now, () => downloader.json('/v1/resolve', {
        method: 'POST',
        body: { ref: originalBranch, detectEsbuild: !skipEsbuild },
        signal: controller.signal,
        correlationId: req.correlationId
      }))
      const commit = resolved.commit
      rate = resolved.rate || {}
      const url = rewriteRef(req.url, originalBranch, commit)
      if (url !== req.url) {
        startTrace(commit)
        setPublicHeaders(res, 302, rate)
        res.set({ 'Cache-Control': 'no-store', 'CDN-Cache-Control': 'no-store' })
        if (rate.limit !== undefined) res.set('X-GitHub-RateLimit-Limit', String(rate.limit))
        return res.redirect(302, url)
      }
      const dashboards = req.params.filepath !== undefined
      const type = getType(commit, url)
      const esbuild = explicitEsbuild || (!dashboards && resolved.needsEsbuild)
      const parsed = esbuild ? getFileForEsbuild(commit, type, url) : { filename: getFile(commit, type, url), minify: false }
      const path = dashboards ? req.params.filepath : parsed.filename

      if (!path) {
        startTrace(commit, dashboards ? 'dashboards' : esbuild ? 'esbuild' : 'legacy')
        return send(res, req, 400, 'Could not find the compiled file. Path: ', rate, commit)
      }

      if (!dashboards && !esbuild) {
        const sourcePath = path.endsWith('.css') ? path : `js/${path}`
        try {
          const response = await observeDependency(telemetry, 'downloader', now, () => downloader.request(`/v1/files/${commit}/${sourcePath}`, { signal: controller.signal, correlationId: req.correlationId }))
          startTrace(commit, 'static')
          return streamResponse(response, res, req, { commit, rate })
        } catch (error) {
          if (!(error instanceof ServiceError) || error.status !== 404) throw error
        }
      }

      const mode = dashboards ? 'dashboards' : esbuild ? 'esbuild' : 'legacy'
      startTrace(commit, mode)
      const response = await observeDependency(telemetry, 'builder', now, () => builder.request('/v1/build', {
        method: 'POST',
        body: { commit, path, mode, options: { minify: parsed.minify, type } },
        signal: controller.signal,
        correlationId: req.correlationId
      }))
      return streamResponse(response, res, req, { commit, rate, builtWith: response.headers.get('x-built-with') })
    } catch (error) {
      startTrace()
      if (controller.signal.aborted) return
      failure = error
      if (res.headersSent) return
      return sendServiceError(res, req, error, rate)
    } finally {
      req.removeListener('aborted', abort)
      if (traceStarted) {
        const status = controller.signal.aborted ? 'aborted' : (failure || res.statusCode >= 400) ? 'failed' : 'succeeded'
        const code = failure ? safeErrorCode(failure) : null
        telemetry.completeSpan(req.correlationId, PUBLIC_OPERATION, { status, httpStatus: res.statusCode, code })
        if (failure) telemetry.recordFailure({ correlationId: req.correlationId, operation: PUBLIC_OPERATION, code, httpStatus: res.statusCode })
        telemetry.completeTrace(req.correlationId, { status, httpStatus: res.statusCode, code })
      }
    }
  }

  router.opsTelemetry = telemetry
  router.opsSnapshot = () => telemetry.snapshot({
    capabilities: [
      capability('public_file_delivery'),
      capability('console_read'),
      capability('console_cache_control', !opsConsoleEnabled, 'NOT_IMPLEMENTED')
    ]
  })

  return router
}

function capability (name, affected = false, reasonCode) {
  return { name, status: affected ? 'unavailable' : 'available', reasonCode: affected ? reasonCode : null }
}

async function observeDependency (telemetry, dependency, now, work) {
  const started = now()
  try {
    const result = await work()
    telemetry.recordDependency(dependency, { succeeded: true, latencyMs: now() - started })
    return result
  } catch (error) {
    telemetry.recordDependency(dependency, { succeeded: false, latencyMs: now() - started, errorCode: safeErrorCode(error) })
    throw error
  }
}

function safeErrorCode (error) {
  return typeof error?.code === 'string' && Object.hasOwn(FAILURE_SUMMARIES, error.code) ? error.code : 'INTERNAL_ERROR'
}

function rewriteRef (url, originalBranch, commit) {
  const prefix = `/${originalBranch}`
  return isExplicitRef(url, originalBranch)
    ? `/${commit}${url.slice(prefix.length)}`
    : url
}

function isExplicitRef (url, originalBranch) {
  const prefix = `/${originalBranch}`
  return url.startsWith(prefix + '/') || url === prefix
}

async function streamResponse (response, res, req, metadata) {
  if (req.connectionAborted) return response.body?.cancel?.()
  setPublicHeaders(res, response.status, metadata.rate)
  res.set('ETag', metadata.commit)
  if (metadata.builtWith) res.set('X-Built-With', metadata.builtWith)
  const contentType = response.headers.get('content-type')
  if (contentType) res.set('Content-Type', contentType)
  res.status(response.status)
  await pipeline(Readable.from(response.body), res)
}

function sendServiceError (res, req, error, rate) {
  if (!(error instanceof ServiceError)) return send(res, req, 500, error.message, rate)
  if (error.rateLimitLimit != null) rate.limit = Number(error.rateLimitLimit)
  if (error.rateLimitRemaining != null) rate.remaining = Number(error.rateLimitRemaining)
  if (error.rateLimitReset != null) rate.reset = Number(error.rateLimitReset)
  if (error.code === 'RATE_LIMITED' || (error.status === 403 && rate.remaining === 0)) {
    return send(res, req, 429, 'GitHub API rate limit exceeded. Please try again later.', rate)
  }
  if (error.code === 'REF_NOT_FOUND') return send(res, req, 200, 'Not found', rate)
  const status = error.code === 'QUEUE_FULL' ? 202 : error.status
  return send(res, req, status, error.message, rate)
}

function send (res, req, status, body, rate = {}, commit) {
  if (req.connectionAborted || res.headersSent) return
  setPublicHeaders(res, status, rate)
  if (rate.limit !== undefined) res.set('X-GitHub-RateLimit-Limit', String(rate.limit))
  if (commit) res.set('ETag', commit)
  return res.status(status).send(body)
}

const router = createRouter()
module.exports = router
module.exports.createRouter = createRouter
module.exports.rewriteRef = rewriteRef
