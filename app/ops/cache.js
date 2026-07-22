'use strict'

const { randomUUID } = require('node:crypto')
const { promises: fs } = require('node:fs')
const { join, resolve } = require('node:path')

const SHA = /^[0-9a-f]{40}$/
const OPERATIONS = new Set(['cache.evict_commit', 'cache.purge_expired', 'cache.clear'])

class CacheError extends Error {
  constructor (code, message) {
    super(message)
    this.name = 'CacheError'
    this.code = code
  }
}

class CacheManager {
  constructor ({ root, service, idleExpiryMs, now = Date.now, concurrency = 4, entryLimit = 200, scanLimit = 100000, filesystem = fs } = {}) {
    if (typeof root !== 'string' || !root) throw new TypeError('Cache root is required')
    if (!['downloader', 'builder'].includes(service)) throw new TypeError('Cache service is invalid')
    if (!Number.isSafeInteger(idleExpiryMs) || idleExpiryMs < 0) throw new TypeError('Cache idle expiry is invalid')
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new TypeError('Cache concurrency is invalid')
    this.root = resolve(root)
    this.service = service
    this.idleExpiryMs = idleExpiryMs
    this.now = now
    this.concurrency = concurrency
    this.entryLimit = entryLimit
    this.scanLimit = scanLimit
    this.fs = filesystem
    this.states = new Map()
    this.sizes = new Map()
  }

  async acquire (commit) {
    commit = parseCommit(commit)
    const state = this.state(commit)
    while (state.deleting) await state.deleting
    state.inUse++
    state.lastUsedAt = this.now()
    let released = false
    return () => {
      if (released) return
      released = true
      state.inUse--
      state.lastUsedAt = this.now()
    }
  }

  async use (commit, work) {
    if (typeof work !== 'function') throw new TypeError('Cache work must be a function')
    const release = await this.acquire(commit)
    try {
      return await work()
    } finally {
      release()
    }
  }

  touch (commit) {
    const state = this.state(parseCommit(commit))
    state.lastUsedAt = this.now()
  }

  async inspect () {
    const names = await this.commitNames()
    const entries = (await mapLimit(names, this.concurrency, name => this.inspectEntry(name))).filter(Boolean)
    const current = new Set(names)
    for (const commit of this.sizes.keys()) {
      if (!current.has(commit)) this.sizes.delete(commit)
    }
    return entries.sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.commit.localeCompare(b.commit))
  }

  async snapshot () {
    const entries = await this.inspect()
    const totalBytes = entries.reduce((total, entry) => safeAdd(total, entry.sizeBytes), 0)
    return {
      entryCount: entries.length,
      totalBytes,
      idleExpiryMs: this.idleExpiryMs,
      entriesTruncated: entries.length > this.entryLimit,
      entries: entries.slice(0, this.entryLimit).map(entry => ({
        commit: entry.commit,
        sizeBytes: entry.sizeBytes,
        lastAccessedAt: new Date(entry.lastUsedAt).toISOString(),
        expiresAt: new Date(entry.lastUsedAt + this.idleExpiryMs).toISOString(),
        inUse: entry.inUse
      }))
    }
  }

  async execute (operation, commit) {
    if (!OPERATIONS.has(operation)) throw new CacheError('INVALID_OPERATION', 'Unknown cache operation')
    if (operation === 'cache.evict_commit') commit = parseCommit(commit)
    else if (commit !== undefined) throw new CacheError('INVALID_OPERATION', 'Commit is not accepted for this operation')

    let candidates
    try {
      candidates = operation === 'cache.evict_commit'
        ? [await this.inspectEntry(commit)].filter(Boolean)
        : await this.inspect()
    } catch (error) {
      return this.result(operation, [], error)
    }

    const threshold = this.now() - this.idleExpiryMs
    if (operation === 'cache.purge_expired') candidates = candidates.filter(entry => entry.lastUsedAt <= threshold)
    const dispositions = await mapLimit(candidates, this.concurrency, entry => this.deleteEntry(entry, operation, threshold))
    return this.result(operation, dispositions, null, operation === 'cache.evict_commit' && candidates.length === 0)
  }

  result (operation, dispositions, initialError, absent = false) {
    const errors = dispositions.filter(item => item.error)
    const removed = dispositions.filter(item => item.removed)
    const skippedInUse = dispositions.filter(item => item.inUse).length
    const skippedChanged = dispositions.filter(item => item.changed).length
    const error = initialError || (errors[0] && errors[0].error)
    const target = {
      service: this.service,
      outcome: error ? 'failed' : removed.length && (skippedInUse || skippedChanged) ? 'partial' : removed.length ? 'completed' : 'no_op',
      removedEntries: removed.length,
      freedBytes: removed.reduce((total, item) => safeAdd(total, item.sizeBytes), 0),
      absent: absent || dispositions.some(item => item.absent),
      skippedInUse,
      error: error ? publicError(error) : null
    }
    if (operation !== 'cache.clear') target.skippedChanged = skippedChanged
    return target
  }

  async deleteEntry (entry, operation, threshold) {
    const state = this.state(entry.commit, entry.lastUsedAt)
    if (state.deleting) {
      await state.deleting
      return { absent: true }
    }
    if (state.inUse) return { inUse: true }

    let finish
    state.deleting = new Promise(resolve => { finish = resolve })
    try {
      if (state.inUse) return { inUse: true }
      const current = await this.entryIdentity(entry.commit)
      if (!current || current.dev !== entry.dev || current.ino !== entry.ino) {
        return operation === 'cache.purge_expired' && current ? { changed: true } : { absent: true }
      }
      if (operation === 'cache.purge_expired' && state.lastUsedAt > threshold) return { changed: true }

      const quarantine = join(this.root, `.ops-delete-${randomUUID()}`)
      try {
        await this.fs.rename(join(this.root, entry.commit), quarantine)
      } catch (error) {
        if (error.code === 'ENOENT') return { absent: true }
        throw error
      }
      await this.fs.rm(quarantine, { recursive: true, force: true })
      this.states.delete(entry.commit)
      this.sizes.delete(entry.commit)
      return { removed: true, sizeBytes: entry.sizeBytes }
    } catch (error) {
      return { error }
    } finally {
      state.deleting = null
      finish()
    }
  }

  async commitNames () {
    let root
    try {
      root = await this.fs.lstat(this.root)
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    if (!root.isDirectory() || root.isSymbolicLink()) throw new CacheError('UNSAFE_CACHE_ROOT', 'Cache root is not a real directory')
    const names = (await this.fs.readdir(this.root, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && SHA.test(entry.name))
      .map(entry => entry.name)
      .sort()
    if (names.length > this.scanLimit) throw new CacheError('CACHE_SCAN_LIMIT', 'Cache entry limit exceeded')
    return names
  }

  async inspectEntry (commit) {
    if (!SHA.test(commit)) return null
    const identity = await this.entryIdentity(commit)
    if (!identity) {
      this.sizes.delete(commit)
      return null
    }
    const marker = await this.fs.lstat(join(this.root, commit, '.complete')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (!marker || !marker.isFile() || marker.isSymbolicLink()) {
      this.sizes.delete(commit)
      return null
    }
    let measured = this.sizes.get(commit)
    if (!measured || measured.dev !== identity.dev || measured.ino !== identity.ino ||
      measured.mtimeMs !== identity.mtimeMs || measured.ctimeMs !== identity.ctimeMs ||
      measured.markerDev !== marker.dev || measured.markerIno !== marker.ino ||
      measured.markerMtimeMs !== marker.mtimeMs || measured.markerCtimeMs !== marker.ctimeMs) {
      const sizeBytes = await this.directorySize(join(this.root, commit), { nodes: 0 })
      measured = {
        dev: identity.dev,
        ino: identity.ino,
        mtimeMs: identity.mtimeMs,
        ctimeMs: identity.ctimeMs,
        markerDev: marker.dev,
        markerIno: marker.ino,
        markerMtimeMs: marker.mtimeMs,
        markerCtimeMs: marker.ctimeMs,
        sizeBytes
      }
      this.sizes.set(commit, measured)
    }
    const fallback = Math.max(identity.mtimeMs, marker.mtimeMs)
    const state = this.state(commit, fallback)
    return { commit, sizeBytes: measured.sizeBytes, lastUsedAt: state.lastUsedAt, inUse: state.inUse, dev: identity.dev, ino: identity.ino }
  }

  async entryIdentity (commit) {
    try {
      const stat = await this.fs.lstat(join(this.root, commit))
      return stat.isDirectory() && !stat.isSymbolicLink() ? stat : null
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  async directorySize (directory, measured) {
    let total = 0
    const entries = await this.fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (++measured.nodes > this.scanLimit) throw new CacheError('CACHE_SCAN_LIMIT', 'Cache content limit exceeded')
      const path = join(directory, entry.name)
      if (entry.isDirectory()) total = safeAdd(total, await this.directorySize(path, measured))
      else if (entry.isFile() || entry.isSymbolicLink()) total = safeAdd(total, (await this.fs.lstat(path)).size)
    }
    return total
  }

  state (commit, fallback = this.now()) {
    let state = this.states.get(commit)
    if (!state) {
      state = { inUse: 0, lastUsedAt: fallback, deleting: null }
      this.states.set(commit, state)
    }
    return state
  }
}

function parseCommit (commit) {
  if (typeof commit !== 'string' || !SHA.test(commit)) throw new CacheError('INVALID_COMMIT', 'Commit must be a canonical lowercase 40-character SHA')
  return commit
}

function safeAdd (left, right) {
  const total = left + right
  if (!Number.isSafeInteger(total) || total < 0) throw new CacheError('CACHE_SIZE_OVERFLOW', 'Cache byte total exceeds the supported range')
  return total
}

function publicError (error) {
  return {
    code: typeof error.code === 'string' && /^[\x21-\x7e]{1,64}$/.test(error.code) ? error.code : 'CACHE_OPERATION_FAILED',
    message: error instanceof CacheError ? error.message : 'Cache operation failed'
  }
}

async function mapLimit (values, limit, mapper) {
  const results = new Array(values.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++
      results[index] = await mapper(values[index], index)
    }
  }))
  return results
}

module.exports = { CacheError, CacheManager, parseCommit }
