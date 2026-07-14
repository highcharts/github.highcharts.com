'use strict'

const { createReadStream, existsSync, promises: fs } = require('node:fs')
const { spawn } = require('node:child_process')
const { join, posix, resolve } = require('node:path')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const config = require('../config.json')
const { createServiceClient, ServiceError } = require('./service-client')
const { createBuilder } = require('./build')
const { removeDirectory } = require('./filesystem')

const SHA_PATTERN = /^[a-f0-9]{40}$/
const MODES = new Set(['legacy', 'webpack', 'dashboards', 'esbuild'])
const SOURCE_PATHS = ['ts', 'js', 'css', 'tools/webpacks', 'tools/libs']

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
  return { commit: body.commit, path: body.path, mode: body.mode, options: body.options || {} }
}

function createBuilderService (options = {}) {
  const cacheRoot = resolve(options.cacheRoot || process.env.BUILDER_CACHE_ROOT || config.builderCacheRoot || join(__dirname, '../tmp'))
  const client = options.client || createServiceClient({
    baseURL: options.downloaderURL || process.env.DOWNLOADER_URL || config.downloaderURL,
    token: options.token === undefined ? process.env.INTERNAL_SERVICE_TOKEN : options.token,
    timeout: options.timeout || process.env.BUILDER_DOWNLOADER_TIMEOUT || config.builderDownloaderTimeout
  })
  const builder = options.builder || createBuilder({ ...options, cacheRoot })
  const cacheLifetime = Number(options.cacheLifetime || process.env.BUILDER_CACHE_LIFETIME || config.builderCacheLifetime || 7 * 24 * 60 * 60 * 1000)
  const pending = new Map()

  function complete (root) {
    return SOURCE_PATHS.every(path => existsSync(join(root, path)))
  }

  async function ensureSource (commit) {
    const root = join(cacheRoot, commit)
    if (complete(root)) return root
    if (pending.has(commit)) return pending.get(commit)
    const promise = extract(commit, root).finally(() => pending.delete(commit))
    pending.set(commit, promise)
    return promise
  }

  async function extract (commit, root) {
    await fs.mkdir(cacheRoot, { recursive: true })
    await fs.rm(root, { recursive: true, force: true })
    const temporary = await fs.mkdtemp(join(cacheRoot, `.extract-${commit}-`))
    try {
      const archive = await client.stream(`/v1/sources/${commit}.tar.gz`)
      const tar = (options.spawn || spawn)('tar', ['-xzf', '-', '-C', temporary], { shell: false, stdio: ['pipe', 'ignore', 'pipe'] })
      let stderr = ''
      tar.stderr.on('data', chunk => { stderr += chunk })
      const closed = new Promise((resolve, reject) => {
        tar.on('error', reject)
        tar.on('close', code => code === 0 ? resolve() : reject(new BuilderError('ARCHIVE_ERROR', stderr || `tar exited with ${code}`, 502)))
      })
      const input = typeof archive.getReader === 'function' ? Readable.fromWeb(archive) : archive
      await Promise.all([pipeline(input, tar.stdin), closed])
      if (!complete(temporary)) throw new BuilderError('SOURCE_INCOMPLETE', 'Source archive is incomplete', 502)
      try {
        await fs.rename(temporary, root)
      } catch (error) {
        if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error
        if (!complete(root)) throw error
      }
      return root
    } catch (error) {
      if (error instanceof BuilderError || error instanceof ServiceError) throw error
      throw new BuilderError('SOURCE_ERROR', error.message, 502, error)
    } finally {
      await fs.rm(temporary, { recursive: true, force: true })
    }
  }

  async function build (body) {
    const request = validateRequest(body)
    await ensureSource(request.commit)
    try {
      const result = await builder.build(request)
      if (!result || !result.file || !existsSync(result.file)) throw new BuilderError('INVALID_BUILD', 'Build did not produce the requested file', 400)
      return { stream: createReadStream(result.file), builtWith: result.builtWith || request.mode, path: request.path }
    } catch (error) {
      if (error.name === 'QueueFullError') throw new BuilderError('QUEUE_FULL', error.message, 503, error)
      throw error
    }
  }

  async function cleanup (force = false) {
    const entries = await fs.readdir(cacheRoot, { withFileTypes: true }).catch(() => [])
    const removed = []
    for (const entry of entries) {
      if (!entry.isDirectory() || pending.has(entry.name)) continue
      const path = join(cacheRoot, entry.name)
      const stat = await fs.stat(path)
      if (force || Date.now() - stat.mtimeMs > cacheLifetime) {
        await removeDirectory(path)
        removed.push(entry.name)
      }
    }
    return removed
  }

  return { build, cacheRoot, cleanup, ensureSource }
}

module.exports = { BuilderError, MODES, SOURCE_PATHS, createBuilderService, validateRequest }
