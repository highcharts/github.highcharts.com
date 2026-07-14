'use strict'

const { createReadStream, existsSync, promises: fs } = require('fs')
const { spawn } = require('child_process')
const { join, relative, resolve, sep } = require('path')
const config = require('../config.json')
const { repo } = config
const download = require('./download')
const { removeDirectory } = require('./filesystem')
const { JobQueue } = require('./JobQueue')

const SHA_PATTERN = /^[a-f0-9]{40}$/i
const SOURCE_PATHS = ['ts', 'js', 'css', 'tools/webpacks', 'tools/libs']
const OPTIONAL_SOURCE_PATHS = ['js', 'tools/webpacks', 'tools/libs']
const ESBUILD_DETECTION_FILE = 'ts/masters/highcharts-autoload.src.ts'
const ESBUILD_DETECTION_TIMEOUT = 5000

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
  const esbuildCache = new Map()

  async function needsEsbuild (commit) {
    if (esbuildCache.has(commit)) return esbuildCache.get(commit)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ESBUILD_DETECTION_TIMEOUT)
    try {
      const response = await fetchImpl(`${sourceURL.replace(/\/?$/, '/')}${commit}/${ESBUILD_DETECTION_FILE}`, {
        method: 'HEAD',
        signal: controller.signal,
        headers: githubToken ? { Authorization: `token ${githubToken}` } : {}
      })
      if (!response.ok && response.status !== 404) {
        throw new DownloaderError('UPSTREAM_ERROR', `GitHub returned ${response.status}`, 502)
      }
      esbuildCache.set(commit, response.ok)
      return response.ok
    } catch (error) {
      if (error instanceof DownloaderError) throw error
      const timedOut = controller.signal.aborted
      throw new DownloaderError(timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR', timedOut ? 'GitHub request timed out' : error.message, timedOut ? 504 : 502, error)
    } finally {
      clearTimeout(timer)
    }
  }

  async function resolveRef (ref) {
    let info = await download.getBranchInfo(ref)
    let commit = info && info.commit && info.commit.sha
    if (!commit) {
      info = await download.getCommitInfo(ref)
      commit = info && info.sha
    }
    if (!SHA_PATTERN.test(commit || '')) {
      throw new DownloaderError('REF_NOT_FOUND', 'Ref was not found', 404)
    }
    commit = commit.toLowerCase()
    return {
      commit,
      needsEsbuild: await needsEsbuild(commit),
      rate: download.getRateLimitState()
    }
  }

  async function ensureSource (commit) {
    commit = validateCommit(commit)
    const root = join(cacheRoot, commit)
    const complete = join(root, '.complete')
    if (existsSync(complete)) return root
    let failure
    try {
      await queue.addJob('download', `downloader:${commit}`, {
        func: async () => {
          try {
            await fs.mkdir(root, { recursive: true })
            const responses = await download.downloadSourceFolder(root, sourceURL.replace(/\/?$/, '/'), commit)
            if (responses.some(response => !response.success)) {
              throw new DownloaderError('SOURCE_INCOMPLETE', 'Source tree is incomplete', 502)
            }
            await Promise.all(OPTIONAL_SOURCE_PATHS.map(path => fs.mkdir(join(root, path), { recursive: true })))
            if (!SOURCE_PATHS.every(path => existsSync(join(root, path)))) {
              throw new DownloaderError('SOURCE_INCOMPLETE', 'Source tree is incomplete', 502)
            }
            await fs.writeFile(complete, '')
          } catch (error) {
            failure = error
            throw error
          }
        },
        args: []
      })
      if (failure) throw failure
      if (!existsSync(complete)) throw new DownloaderError('SOURCE_INCOMPLETE', 'Source tree is incomplete', 502)
    } catch (error) {
      await fs.rm(root, { recursive: true, force: true })
      if (error.name === 'QueueFullError') throw new DownloaderError('QUEUE_FULL', error.message, 503, error)
      throw error
    }
    return root
  }

  async function openFile (commit, filepath) {
    commit = validateCommit(commit)
    const sourcePath = safeFilePath(cacheRoot, commit, filepath)
    const sourceRoot = join(cacheRoot, commit)
    if (existsSync(join(sourceRoot, '.complete'))) {
      const stat = await fs.stat(sourcePath).catch(() => false)
      if (stat && stat.isFile()) return createReadStream(sourcePath)
    }

    const fileCacheRoot = join(cacheRoot, '.files')
    const path = safeFilePath(fileCacheRoot, commit, filepath)
    const stat = await fs.stat(path).catch(() => false)
    if (stat && stat.isFile()) return createReadStream(path)

    const result = await download.downloadFile(`${sourceURL.replace(/\/?$/, '/')}${commit}/${filepath}`, path)
    if (!result.success) {
      const notFound = result.statusCode === 404
      throw new DownloaderError(notFound ? 'FILE_NOT_FOUND' : 'UPSTREAM_ERROR', notFound ? 'File was not found' : `GitHub returned ${result.statusCode}`, notFound ? 404 : 502)
    }
    return createReadStream(path)
  }

  async function archive (commit) {
    const root = await ensureSource(commit)
    return spawn('tar', ['-czf', '-', '--', ...SOURCE_PATHS], {
      cwd: root,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  }

  async function cleanup (force = false) {
    const entries = await fs.readdir(cacheRoot, { withFileTypes: true }).catch(() => [])
    const removed = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const path = join(cacheRoot, entry.name)
      const stat = await fs.stat(path)
      if (force || Date.now() - stat.mtimeMs > cacheLifetime) {
        await removeDirectory(path)
        removed.push(entry.name)
      }
    }
    return removed
  }

  return { archive, cacheRoot, cleanup, ensureSource, needsEsbuild, openFile, resolveRef }
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
