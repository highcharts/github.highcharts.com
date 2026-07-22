'use strict'

const { createReadStream, createWriteStream, existsSync, promises: fs } = require('node:fs')
const { spawn } = require('node:child_process')
const { join, posix, resolve } = require('node:path')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { createGunzip } = require('node:zlib')
const config = require('../config.json')
const { createServiceClient, ServiceError } = require('./service-client')
const { createBuilder } = require('./build')
const { JobQueue } = require('./JobQueue')
const { CacheManager } = require('./ops/cache')
const { Telemetry } = require('./ops/telemetry')

const SHA_PATTERN = /^[a-f0-9]{40}$/
const WEBPACK_CONFIG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MODES = new Set(['legacy', 'webpack', 'dashboards', 'esbuild'])
const SOURCE_PATHS = ['ts', 'js', 'css', 'tools/webpacks', 'tools/libs']
const ARCHIVE_BODY_TIMEOUT = 120000
const MAX_COMPRESSED_BYTES = 32 * 1024 * 1024
const MAX_INFLATED_BYTES = 64 * 1024 * 1024
const MAX_ENTRIES = 5000
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_PATH_BYTES = 512
const OPERATIONS = ['source_download', 'build']
const ROUTES = ['/v1/build']
const FAILURE_SUMMARIES = {
  ARCHIVE_ERROR: 'Source archive extraction failed',
  DOWNLOADER_ERROR: 'Downloader request failed',
  DOWNLOADER_TIMEOUT: 'Downloader request timed out',
  INVALID_BUILD: 'Build did not produce the requested file',
  INVALID_COMMIT: 'Commit is invalid',
  INVALID_MODE: 'Build mode is invalid',
  INVALID_OPTIONS: 'Build options are invalid',
  INVALID_PATH: 'Build output path is invalid',
  QUEUE_FULL: 'Build capacity is unavailable',
  SOURCE_INCOMPLETE: 'Source archive is incomplete'
}

class BuilderError extends Error {
  constructor (code, message, status = 500, cause) {
    super(message, { cause })
    this.name = code === 'QUEUE_FULL' ? 'QueueFullError' : 'BuilderError'
    this.code = code
    this.status = status
  }
}

function validateRequest (body = {}) {
  if (!SHA_PATTERN.test(body.commit || '')) throw new BuilderError('INVALID_COMMIT', 'Commit must be a canonical 40-character SHA', 400)
  if (typeof body.path !== 'string' || !body.path || body.path.includes('\\') || posix.isAbsolute(body.path) || posix.normalize(body.path) !== body.path || body.path === '..' || body.path.startsWith('../')) {
    throw new BuilderError('INVALID_PATH', 'Path must be a normalized relative output path', 400)
  }
  if (!MODES.has(body.mode)) throw new BuilderError('INVALID_MODE', 'Unknown build mode', 400)
  if (body.options !== undefined && (!body.options || typeof body.options !== 'object' || Array.isArray(body.options))) {
    throw new BuilderError('INVALID_OPTIONS', 'Options must be an object', 400)
  }
  if (body.options?.config !== undefined && (typeof body.options.config !== 'string' || !WEBPACK_CONFIG_PATTERN.test(body.options.config))) {
    throw new BuilderError('INVALID_OPTIONS', FAILURE_SUMMARIES.INVALID_OPTIONS, 400)
  }
  return { commit: body.commit, path: body.path, mode: body.mode, options: body.options || {} }
}

function createBuilderService (options = {}) {
  const cacheRoot = resolve(options.cacheRoot || process.env.BUILDER_CACHE_ROOT || config.builderCacheRoot || join(__dirname, '../tmp'))
  const cacheLifetime = Number(options.cacheLifetime || process.env.BUILDER_CACHE_LIFETIME || config.builderCacheLifetime || 7 * 24 * 60 * 60 * 1000)
  const now = options.now || Date.now
  const queue = options.queue || new JobQueue()
  const cacheManager = options.cacheManager || new CacheManager({ root: cacheRoot, service: 'builder', idleExpiryMs: cacheLifetime, now })
  const telemetry = options.telemetry || new Telemetry({ service: 'builder', operations: OPERATIONS, routes: ROUTES, failureSummaries: FAILURE_SUMMARIES, now })
  const client = options.client || createServiceClient({
    baseURL: options.downloaderURL || process.env.DOWNLOADER_URL || config.downloaderURL,
    token: options.token === undefined ? process.env.INTERNAL_SERVICE_TOKEN : options.token,
    timeout: options.timeout || process.env.BUILDER_DOWNLOADER_TIMEOUT || config.builderDownloaderTimeout
  })
  const builder = options.builder || createBuilder({ ...options, cacheRoot, queue })
  const pending = new Map()

  function complete (root) {
    return SOURCE_PATHS.every(path => existsSync(join(root, path)))
  }

  function ensureSource (commit, context = {}) {
    return cacheManager.use(commit, () => ensureSourceInUse(commit, context))
  }

  async function ensureSourceInUse (commit, context) {
    const root = join(cacheRoot, commit)
    if (complete(root)) return root
    if (pending.has(commit)) return pending.get(commit)
    const promise = observe(context.correlationId, 'source_download', () => extract(commit, root), true, commit)
      .finally(() => pending.delete(commit))
    pending.set(commit, promise)
    return promise
  }

  async function extract (commit, root) {
    await fs.mkdir(cacheRoot, { recursive: true })
    await fs.rm(root, { recursive: true, force: true })
    const archiveDirectory = await fs.mkdtemp(join(cacheRoot, `.archive-${commit}-`))
    const archivePath = join(archiveDirectory, 'source.tar.gz')
    let temporary
    try {
      temporary = await fs.mkdtemp(join(cacheRoot, `.extract-${commit}-`))
      const archive = await client.stream(`/v1/sources/${commit}.tar.gz`, { timeoutThroughBody: true })
      const input = typeof archive.getReader === 'function' ? Readable.fromWeb(archive) : archive
      await saveArchive(input, archivePath)
      await preflightArchive(archivePath)
      await extractArchive(archivePath, temporary, options.spawn || spawn)
      await inspectExtracted(temporary)
      if (!complete(temporary)) throw new BuilderError('SOURCE_INCOMPLETE', 'Source archive is incomplete', 502)
      try {
        await fs.rename(temporary, root)
      } catch (error) {
        if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error
        if (!complete(root)) throw error
      }
      return root
    } catch (error) {
      throw sanitize(error)
    } finally {
      await Promise.all([
        fs.rm(archiveDirectory, { recursive: true, force: true }),
        temporary && fs.rm(temporary, { recursive: true, force: true })
      ])
    }
  }

  async function build (body, context = {}) {
    telemetry.startSpan(context.correlationId, 'build')
    let release
    let request
    try {
      request = validateRequest(body)
      release = await cacheManager.acquire(request.commit)
      await ensureSourceInUse(request.commit, context)
      const result = await builder.build(request)
      if (!result || !result.file || !existsSync(result.file)) throw new BuilderError('INVALID_BUILD', 'Build did not produce the requested file', 400)
      await fs.writeFile(join(cacheRoot, request.commit, '.complete'), '')
      return {
        stream: observedStream(createReadStream(result.file), release, context.correlationId, telemetry, request.commit),
        builtWith: result.builtWith || request.mode,
        path: request.path
      }
    } catch (error) {
      release?.()
      failed(context.correlationId, 'build', error, request?.commit)
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
    const queueMetrics = typeof queue.getMetrics === 'function' ? queue.getMetrics('compile', now()) : { active: 0, queued: 0, limit: 0, oldestQueuedAgeMs: null }
    let cache
    let cacheError = false
    try {
      cache = await cacheManager.snapshot()
    } catch (error) {
      cache = null
      cacheError = true
    }
    const downloader = telemetry.dependencies().find(dependency => dependency.name === 'downloader')
    const queueSaturated = queueMetrics.limit > 0 && queueMetrics.active + queueMetrics.queued >= queueMetrics.limit
    const dependencyFailed = downloader && !['available', 'unknown'].includes(downloader.status)
    return telemetry.snapshot({
      capabilities: [
        capability('build_delivery', queueSaturated || dependencyFailed, queueSaturated ? 'QUEUE_SATURATED' : downloader?.status === 'unavailable' ? 'DOWNLOADER_UNAVAILABLE' : 'DOWNLOADER_DEGRADED'),
        capability('cache_control', cacheError, 'CACHE_INSPECTION_FAILED')
      ],
      queues: [{ name: 'build', ...queueMetrics }],
      cache
    })
  }

  function startRequest (details) {
    return telemetry.startTrace(details)
  }

  function completeRequest (correlationId, outcome) {
    return telemetry.completeTrace(correlationId, outcome)
  }

  async function observe (correlationId, operation, work, dependency = false, commit = null) {
    const started = now()
    telemetry.startSpan(correlationId, operation)
    try {
      const result = await work()
      telemetry.completeSpan(correlationId, operation, { status: 'succeeded' })
      if (dependency) telemetry.recordDependency('downloader', { succeeded: true, latencyMs: now() - started })
      return result
    } catch (error) {
      const safe = safeError(error)
      if (dependency) telemetry.recordDependency('downloader', { succeeded: false, latencyMs: now() - started, errorCode: safe.code })
      failed(correlationId, operation, safe, commit)
      throw safe
    }
  }

  function failed (correlationId, operation, error, commit) {
    const safe = safeError(error)
    telemetry.completeSpan(correlationId, operation, { status: safe.code === 'QUEUE_FULL' ? 'rejected' : 'failed', httpStatus: safe.status, code: safe.code })
    telemetry.recordFailure({ correlationId, operation, code: safe.code, httpStatus: safe.status, commit })
  }

  return { build, cacheManager, cacheRoot, cleanup, completeRequest, ensureSource, snapshot, startRequest, telemetry }
}

async function saveArchive (input, archivePath) {
  let timedOut = false
  let size = 0
  const controller = new AbortController()
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, ARCHIVE_BODY_TIMEOUT)
  const limit = new Transform({
    transform (chunk, encoding, callback) {
      size += chunk.length
      callback(size > MAX_COMPRESSED_BYTES ? archiveError() : null, chunk)
    }
  })
  try {
    await pipeline(input, limit, createWriteStream(archivePath, { flags: 'wx' }), { signal: controller.signal })
  } catch (error) {
    if (timedOut) throw new ServiceError('SERVICE_TIMEOUT', 'Service request timed out', 504, { cause: error })
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function preflightArchive (archivePath) {
  const input = createReadStream(archivePath)
  const gunzip = createGunzip()
  const parser = createTarParser()
  let inflated = 0
  input.pipe(gunzip)
  try {
    for await (const chunk of gunzip) {
      inflated += chunk.length
      if (inflated > MAX_INFLATED_BYTES) throw archiveError()
      parser.write(chunk)
    }
    parser.end()
  } catch (error) {
    input.destroy()
    gunzip.destroy()
    if (error instanceof BuilderError) throw error
    throw archiveError(error)
  }
}

function createTarParser () {
  let buffer = Buffer.alloc(0)
  let remaining = 0
  let entries = 0
  let zeroBlocks = 0
  let ended = false
  const names = new Set()

  return {
    write (chunk) {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length) {
        if (remaining) {
          const consumed = Math.min(remaining, buffer.length)
          remaining -= consumed
          buffer = buffer.subarray(consumed)
          continue
        }
        if (buffer.length < 512) return
        const header = buffer.subarray(0, 512)
        buffer = buffer.subarray(512)
        if (header.every(byte => byte === 0)) {
          zeroBlocks++
          if (zeroBlocks === 2) ended = true
          continue
        }
        if (ended || zeroBlocks) throw archiveError()
        const entry = parseTarHeader(header)
        entries++
        if (entries > MAX_ENTRIES || names.has(entry.path)) throw archiveError()
        names.add(entry.path)
        remaining = Math.ceil(entry.size / 512) * 512
      }
    },
    end () {
      if (!ended || remaining || buffer.length) throw archiveError()
    }
  }
}

function parseTarHeader (header) {
  const expectedChecksum = parseTarNumber(header.subarray(148, 156))
  let checksum = 0
  for (let i = 0; i < header.length; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]
  if (checksum !== expectedChecksum) throw archiveError()

  const name = tarString(header.subarray(0, 100))
  const prefix = tarString(header.subarray(345, 500))
  const rawPath = prefix ? `${prefix}/${name}` : name
  const type = header[156]
  const directory = type === 53
  if (type !== 0 && type !== 48 && !directory) throw archiveError()
  const size = parseTarNumber(header.subarray(124, 136))
  if ((directory && size !== 0) || (!directory && size > MAX_FILE_BYTES)) throw archiveError()
  return { path: archivePath(rawPath, directory), size }
}

function parseTarNumber (field) {
  if (field[0] & 0x80) throw archiveError()
  const value = field.toString('ascii').replace(/\0.*$/, '').trim()
  if (!/^[0-7]+$/.test(value)) throw archiveError()
  const number = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(number)) throw archiveError()
  return number
}

function tarString (field) {
  const nul = field.indexOf(0)
  const bytes = nul === -1 ? field : field.subarray(0, nul)
  if (nul !== -1 && field.subarray(nul).some(byte => byte !== 0)) throw archiveError()
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw archiveError(error)
  }
}

function archivePath (rawPath, directory) {
  if (!rawPath || Buffer.byteLength(rawPath) > MAX_PATH_BYTES || rawPath.includes('\0') || rawPath.includes('\\') || posix.isAbsolute(rawPath)) throw archiveError()
  const path = directory && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath
  const segments = path.split('/')
  if (!path || segments.some(segment => !segment || segment === '.' || segment === '..') || posix.normalize(path) !== path) throw archiveError()
  if (!allowedPath(path, directory)) throw archiveError()
  return path
}

function allowedPath (path, directory) {
  return (directory && path === 'tools') || SOURCE_PATHS.some(root => path === root || path.startsWith(`${root}/`))
}

async function extractArchive (archivePath, destination, spawnImpl) {
  const child = spawnImpl('tar', ['-xzf', archivePath, '-C', destination, '--no-same-owner', '--no-same-permissions'], {
    shell: false,
    stdio: ['ignore', 'ignore', 'pipe']
  })
  child.stderr?.resume()
  await new Promise((resolve, reject) => {
    let settled = false
    const finish = error => {
      if (settled) return
      settled = true
      if (error) {
        child.kill?.()
        reject(archiveError(error))
      } else resolve()
    }
    child.once('error', finish)
    child.once('close', code => finish(code === 0 ? null : archiveError()))
  })
}

async function inspectExtracted (root) {
  let nodes = 0
  let totalSize = 0
  const pending = ['']
  while (pending.length) {
    const parent = pending.pop()
    for (const name of await fs.readdir(join(root, parent))) {
      const path = parent ? `${parent}/${name}` : name
      const stat = await fs.lstat(join(root, path))
      nodes++
      if (nodes > MAX_ENTRIES || (!stat.isDirectory() && !stat.isFile()) || (SOURCE_PATHS.includes(path) && !stat.isDirectory())) throw archiveError()
      archivePath(path, stat.isDirectory())
      if (stat.isDirectory()) {
        pending.push(path)
      } else {
        if (stat.size > MAX_FILE_BYTES) throw archiveError()
        totalSize += stat.size
        if (totalSize > MAX_INFLATED_BYTES) throw archiveError()
      }
    }
  }
}

function archiveError (cause) {
  return new BuilderError('ARCHIVE_ERROR', FAILURE_SUMMARIES.ARCHIVE_ERROR, 502, cause)
}

function observedStream (stream, release, correlationId, telemetry, commit) {
  let completed = false
  const finish = error => {
    if (completed) return
    completed = true
    release()
    if (error) {
      const safe = safeError(error)
      telemetry.completeSpan(correlationId, 'build', { status: 'failed', httpStatus: safe.status, code: safe.code })
      telemetry.recordFailure({ correlationId, operation: 'build', code: safe.code, httpStatus: safe.status, commit })
    } else {
      telemetry.completeSpan(correlationId, 'build', { status: 'succeeded', httpStatus: 200 })
    }
  }
  stream.once('error', finish)
  stream.once('end', () => finish())
  stream.once('close', () => finish())
  return stream
}

function safeError (error) {
  if (error instanceof BuilderError && Object.hasOwn(FAILURE_SUMMARIES, error.code)) return error
  if (error?.name === 'QueueFullError' || error?.code === 'QUEUE_FULL') return new BuilderError('QUEUE_FULL', FAILURE_SUMMARIES.QUEUE_FULL, 503, error)
  if (error instanceof ServiceError) {
    const code = error.code === 'SERVICE_TIMEOUT' ? 'DOWNLOADER_TIMEOUT' : error.code === 'SOURCE_INCOMPLETE' ? 'SOURCE_INCOMPLETE' : 'DOWNLOADER_ERROR'
    const result = new BuilderError(code, FAILURE_SUMMARIES[code], code === 'DOWNLOADER_TIMEOUT' ? 504 : 502, error)
    for (const field of ['retryAfter', 'rateLimitRemaining', 'rateLimitReset']) result[field] = error[field]
    return result
  }
  if (Object.hasOwn(FAILURE_SUMMARIES, error?.code)) return new BuilderError(error.code, FAILURE_SUMMARIES[error.code], error.status || 500, error)
  return new BuilderError('INTERNAL_ERROR', 'An internal error occurred', 500, error)
}

function sanitize (error) {
  return safeError(error)
}

function capability (name, degraded, reasonCode) {
  return { name, status: degraded ? 'degraded' : 'available', reasonCode: degraded ? reasonCode : null }
}

module.exports = { BuilderError, MODES, SOURCE_PATHS, createBuilderService, validateRequest }
