'use strict'

const { createReadStream, existsSync, promises: fs } = require('fs')
const { spawn } = require('child_process')
const { join, relative, resolve, sep } = require('path')
const config = require('../config.json')
const { repo } = config
const download = require('./download')
const { JobQueue } = require('./JobQueue')
const { CacheManager } = require('./ops/cache')
const { Telemetry } = require('./ops/telemetry')

const SHA_PATTERN = /^[a-f0-9]{40}$/i
const SOURCE_PATHS = ['ts', 'js', 'css', 'tools/webpacks', 'tools/libs']
const OPTIONAL_SOURCE_PATHS = ['js', 'tools/webpacks', 'tools/libs']
const ESBUILD_DETECTION_FILE = 'ts/masters/highcharts-autoload.src.ts'
const ESBUILD_DETECTION_TIMEOUT = 5000
const SOURCE_COMPLETE = '.source-complete'
const OPERATIONS = ['github_branch_lookup', 'github_commit_lookup', 'github_esbuild_detection', 'source_download', 'file_download', 'source_archive']
const ROUTES = ['/v1/resolve', '/v1/files/:commit/*', '/v1/sources/:commit.tar.gz']
const FAILURE_SUMMARIES = {
  FILE_NOT_FOUND: 'File was not found',
  INVALID_COMMIT: 'Commit is invalid',
  INVALID_PATH: 'File path is invalid',
  QUEUE_FULL: 'Download capacity is unavailable',
  RATE_LIMITED: 'GitHub rate limit is exhausted',
  REF_NOT_FOUND: 'Ref was not found',
  SOURCE_INCOMPLETE: 'Source tree is incomplete',
  UPSTREAM_ERROR: 'GitHub request failed',
  UPSTREAM_TIMEOUT: 'GitHub request timed out'
}

class DownloaderError extends Error {
  constructor (code, message, status = 500, cause) {
    super(message, { cause })
    this.name = code === 'QUEUE_FULL' ? 'QueueFullError' : 'DownloaderError'
    this.code = code
    this.status = status
  }
}

function validateCommit (commit) {
  if (!SHA_PATTERN.test(commit || '')) {
    throw new DownloaderError('INVALID_COMMIT', 'Commit must be a 40-character SHA', 400)
  }
  return commit.toLowerCase()
}

function safeFilePath (root, commit, filepath) {
  const commitRoot = resolve(root, validateCommit(commit))
  return safeChildPath(commitRoot, filepath)
}

function safeChildPath (root, filepath) {
  const commitRoot = resolve(root)
  const target = resolve(commitRoot, filepath || '')
  if (!filepath || target === commitRoot || relative(commitRoot, target).startsWith(`..${sep}`) || relative(commitRoot, target) === '..') {
    throw new DownloaderError('INVALID_PATH', 'Unsafe file path', 400)
  }
  return target
}

function createDownloaderService (options = {}) {
  const cacheRoot = resolve(options.cacheRoot || process.env.DOWNLOADER_CACHE_ROOT || config.downloaderCacheRoot || join(__dirname, '../downloader-cache'))
  const githubToken = options.githubToken === undefined ? process.env.GITHUB_TOKEN : options.githubToken
  const cacheLifetime = Number(options.cacheLifetime || process.env.DOWNLOADER_CACHE_LIFETIME || config.downloaderCacheLifetime || 7 * 24 * 60 * 60 * 1000)
  const sourceURL = options.sourceURL || process.env.DOWNLOADER_SOURCE_URL || config.downloaderSourceURL || `https://raw.githubusercontent.com/${repo}/`
  const fetchImpl = options.fetch || global.fetch
  const queue = options.queue || new JobQueue()
  const now = options.now || Date.now
  const cacheManager = options.cacheManager || new CacheManager({ root: cacheRoot, service: 'downloader', idleExpiryMs: cacheLifetime, now })
  const telemetry = options.telemetry || new Telemetry({ service: 'downloader', operations: OPERATIONS, routes: ROUTES, failureSummaries: FAILURE_SUMMARIES, now })
  const esbuildCache = new Map()
  const esbuildPending = new Map()
  const sourcePending = new Map()

  async function needsEsbuild (commit, context = {}) {
    commit = validateCommit(commit)
    return cacheManager.use(commit, () => {
      const complete = join(cacheRoot, commit, '.complete')
      if (esbuildCache.has(commit) && existsSync(complete)) return esbuildCache.get(commit)
      esbuildCache.delete(commit)

      let pending = esbuildPending.get(commit)
      if (!pending) {
        pending = detectEsbuild(commit, complete, context)
        esbuildPending.set(commit, pending)
      }
      return pending
    })
  }

  async function detectEsbuild (commit, complete, context) {
    try {
      return await observe(context.correlationId, 'github_esbuild_detection', async () => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), ESBUILD_DETECTION_TIMEOUT)
        try {
          const response = await fetchImpl(`${sourceURL.replace(/\/?$/, '/')}${commit}/${ESBUILD_DETECTION_FILE}`, {
            method: 'HEAD',
            signal: controller.signal,
            headers: githubToken ? { Authorization: `token ${githubToken}` } : {}
          })
          if (!response.ok && response.status !== 404) {
            throw new DownloaderError('UPSTREAM_ERROR', 'GitHub request failed', 502)
          }
          esbuildCache.set(commit, response.ok)
          await fs.mkdir(join(cacheRoot, commit), { recursive: true })
          await fs.writeFile(complete, '')
          return response.ok
        } catch (error) {
          if (error instanceof DownloaderError) throw error
          const timedOut = controller.signal.aborted
          throw new DownloaderError(timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR', timedOut ? 'GitHub request timed out' : 'GitHub request failed', timedOut ? 504 : 502, error)
        } finally {
          clearTimeout(timer)
        }
      }, true, commit)
    } finally {
      esbuildPending.delete(commit)
    }
  }

  async function resolveRef (ref, context = {}) {
    let info = await observe(context.correlationId, 'github_branch_lookup', () => download.getBranchInfo(ref), true)
    let commit = info && info.commit && info.commit.sha
    if (!commit) {
      info = await observe(context.correlationId, 'github_commit_lookup', () => download.getCommitInfo(ref), true)
      commit = info && info.sha
    }
    if (!SHA_PATTERN.test(commit || '')) {
      throw new DownloaderError('REF_NOT_FOUND', 'Ref was not found', 404)
    }
    commit = commit.toLowerCase()
    return {
      commit,
      needsEsbuild: await needsEsbuild(commit, context),
      rate: download.getRateLimitState()
    }
  }

  async function ensureSource (commit, context = {}) {
    commit = validateCommit(commit)
    return cacheManager.use(commit, async () => {
      const root = join(cacheRoot, commit)
      if (sourceIsComplete(root)) return root
      let pending = sourcePending.get(commit)
      if (!pending) {
        pending = populateSource(commit, root, context)
        sourcePending.set(commit, pending)
      }
      return pending
    })
  }

  async function populateSource (commit, root, context) {
    try {
      try {
        await queue.addJob('download', `downloader:${commit}`, {
          func: async () => {
            await fs.mkdir(root, { recursive: true })
            const responses = await observe(context.correlationId, 'source_download', () => download.downloadSourceFolder(root, sourceURL.replace(/\/?$/, '/'), commit), true, commit)
            if (responses.some(response => !response.success)) {
              throw new DownloaderError('SOURCE_INCOMPLETE', 'Source tree is incomplete', 502)
            }
            await Promise.all(OPTIONAL_SOURCE_PATHS.map(path => fs.mkdir(join(root, path), { recursive: true })))
            if (!SOURCE_PATHS.every(path => existsSync(join(root, path)))) {
              throw new DownloaderError('SOURCE_INCOMPLETE', 'Source tree is incomplete', 502)
            }
            await fs.writeFile(join(root, SOURCE_COMPLETE), '')
            await fs.writeFile(join(root, '.complete'), '')
          },
          args: []
        })
        if (!sourceIsComplete(root)) throw new DownloaderError('SOURCE_INCOMPLETE', 'Source tree is incomplete', 502)
      } catch (error) {
        await Promise.all([...SOURCE_PATHS, SOURCE_COMPLETE].map(path => fs.rm(join(root, path), { recursive: true, force: true })))
        if (!existsSync(join(root, '.complete'))) await fs.rm(root, { recursive: true, force: true })
        if (error.name === 'QueueFullError') throw new DownloaderError('QUEUE_FULL', 'Download capacity is unavailable', 503, error)
        throw error
      }
      return root
    } finally {
      sourcePending.delete(commit)
    }
  }

  async function openFile (commit, filepath, context = {}) {
    commit = validateCommit(commit)
    const release = await cacheManager.acquire(commit)
    telemetry.startSpan(context.correlationId, 'file_download')
    try {
      const sourceRoot = join(cacheRoot, commit)
      const sourcePath = safeFilePath(cacheRoot, commit, filepath)
      if (sourceIsComplete(sourceRoot)) {
        const stat = await fs.stat(sourcePath).catch(() => false)
        if (stat && stat.isFile()) return observedStream(createReadStream(sourcePath), release, context.correlationId, 'file_download', telemetry, failed, commit)
      }

      const fileCacheRoot = join(cacheRoot, commit, '.files')
      const path = safeChildPath(fileCacheRoot, filepath)
      const stat = await fs.stat(path).catch(() => false)
      if (!(stat && stat.isFile())) {
        const started = now()
        let result
        try {
          result = await download.downloadFile(`${sourceURL.replace(/\/?$/, '/')}${commit}/${filepath}`, path)
          telemetry.recordDependency('github', { succeeded: result.success, latencyMs: now() - started, errorCode: result.success ? null : result.statusCode === 404 ? 'FILE_NOT_FOUND' : 'UPSTREAM_ERROR' })
        } catch (error) {
          telemetry.recordDependency('github', { succeeded: false, latencyMs: now() - started, errorCode: safeError(error).code })
          throw error
        }
        if (!result.success) {
          const notFound = result.statusCode === 404
          throw new DownloaderError(notFound ? 'FILE_NOT_FOUND' : 'UPSTREAM_ERROR', notFound ? 'File was not found' : 'GitHub request failed', notFound ? 404 : 502)
        }
        const downloaded = await fs.stat(path).catch(() => false)
        if (!(downloaded && downloaded.isFile())) throw new DownloaderError('SOURCE_INCOMPLETE', 'Source tree is incomplete', 502)
        await fs.writeFile(join(cacheRoot, commit, '.complete'), '')
      }
      return observedStream(createReadStream(path), release, context.correlationId, 'file_download', telemetry, failed, commit)
    } catch (error) {
      release()
      failed(context.correlationId, 'file_download', error, commit)
      throw sanitize(error)
    }
  }

  async function archive (commit, context = {}) {
    commit = validateCommit(commit)
    const release = await cacheManager.acquire(commit)
    telemetry.startSpan(context.correlationId, 'source_archive')
    try {
      const root = await ensureSource(commit, context)
      const child = spawn('tar', ['-czf', '-', '--', ...SOURCE_PATHS], {
        cwd: root,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let completed = false
      const finish = (error) => {
        if (completed) return
        completed = true
        release()
        if (error) failed(context.correlationId, 'source_archive', error, commit)
        else telemetry.completeSpan(context.correlationId, 'source_archive', { status: 'succeeded', httpStatus: 200 })
      }
      child.once('error', finish)
      child.once('close', code => finish(code ? new DownloaderError('INTERNAL_ERROR', 'Archive generation failed', 500) : null))
      return child
    } catch (error) {
      release()
      failed(context.correlationId, 'source_archive', error, commit)
      throw sanitize(error)
    }
  }

  async function cleanup (force = false) {
    const before = await cacheManager.inspect()
    await cacheManager.execute(force ? 'cache.clear' : 'cache.purge_expired')
    const remaining = new Set((await cacheManager.inspect()).map(entry => entry.commit))
    return before.map(entry => entry.commit).filter(commit => !remaining.has(commit))
  }

  async function snapshot () {
    const queueMetrics = typeof queue.getMetrics === 'function' ? queue.getMetrics('download', now()) : { active: 0, queued: 0, limit: 0, oldestQueuedAgeMs: null }
    let cache
    let cacheError = false
    try {
      cache = await cacheManager.snapshot()
    } catch (error) {
      cache = null
      cacheError = true
    }
    const github = telemetry.dependencies().find(dependency => dependency.name === 'github')
    const queueSaturated = queueMetrics.active + queueMetrics.queued >= queueMetrics.limit && queueMetrics.limit > 0
    const githubFailure = github && github.status !== 'available' && github.status !== 'unknown'
    return telemetry.snapshot({
      capabilities: [
        capability('ref_resolution', githubFailure, github?.status === 'unavailable' ? 'GITHUB_UNAVAILABLE' : 'GITHUB_DEGRADED'),
        capability('source_file_delivery', githubFailure, 'GITHUB_DEGRADED'),
        capability('source_archive_delivery', githubFailure || queueSaturated, queueSaturated ? 'QUEUE_SATURATED' : 'GITHUB_DEGRADED'),
        capability('cache_control', cacheError, 'CACHE_INSPECTION_FAILED')
      ],
      queues: [{ name: 'download', ...queueMetrics }],
      cache
    })
  }

  function startRequest (details) {
    return telemetry.startTrace(details)
  }

  function completeRequest (correlationId, outcome) {
    return telemetry.completeTrace(correlationId, outcome)
  }

  function sourceIsComplete (root) {
    return existsSync(join(root, SOURCE_COMPLETE)) || (existsSync(join(root, '.complete')) && SOURCE_PATHS.every(path => existsSync(join(root, path))))
  }

  async function observe (correlationId, operation, work, dependency = false, commit = null) {
    const started = now()
    telemetry.startSpan(correlationId, operation)
    try {
      const result = await work()
      telemetry.completeSpan(correlationId, operation, { status: 'succeeded' })
      if (dependency) telemetry.recordDependency('github', { succeeded: true, latencyMs: now() - started })
      return result
    } catch (error) {
      if (dependency) telemetry.recordDependency('github', { succeeded: false, latencyMs: now() - started, errorCode: safeError(error).code })
      failed(correlationId, operation, error, commit)
      throw sanitize(error)
    }
  }

  function failed (correlationId, operation, error, commit) {
    const safe = safeError(error)
    telemetry.completeSpan(correlationId, operation, { status: safe.code === 'QUEUE_FULL' ? 'rejected' : 'failed', httpStatus: safe.status, code: safe.code })
    telemetry.recordFailure({ correlationId, operation, code: safe.code, httpStatus: safe.status, commit })
  }

  return { archive, cacheManager, cacheRoot, cleanup, completeRequest, ensureSource, needsEsbuild, openFile, resolveRef, snapshot, startRequest, telemetry }
}

function observedStream (stream, release, correlationId, operation, telemetry, failed, commit) {
  let completed = false
  const finish = (error) => {
    if (completed) return
    completed = true
    release()
    if (error) failed(correlationId, operation, error, commit)
    else telemetry.completeSpan(correlationId, operation, { status: 'succeeded', httpStatus: 200 })
  }
  stream.once('error', finish)
  stream.once('end', () => finish())
  stream.once('close', () => finish())
  return stream
}

function safeError (error) {
  if (error instanceof DownloaderError && Object.hasOwn(FAILURE_SUMMARIES, error.code)) return error
  if (error?.code === 'RATE_LIMITED') {
    const result = new DownloaderError('RATE_LIMITED', 'GitHub rate limit is exhausted', 429, error)
    for (const field of ['rateLimitLimit', 'rateLimitRemaining', 'rateLimitReset']) result[field] = error[field]
    return result
  }
  return new DownloaderError('INTERNAL_ERROR', 'An internal error occurred', 500, error)
}

function sanitize (error) {
  return safeError(error)
}

function capability (name, degraded, reasonCode) {
  return { name, status: degraded ? 'degraded' : 'available', reasonCode: degraded ? reasonCode : null }
}

module.exports = {
  DownloaderError,
  ESBUILD_DETECTION_FILE,
  ESBUILD_DETECTION_TIMEOUT,
  OPTIONAL_SOURCE_PATHS,
  SOURCE_PATHS,
  createDownloaderService,
  safeFilePath,
  validateCommit
}
