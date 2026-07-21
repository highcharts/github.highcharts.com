'use strict'

const assert = require('node:assert/strict')
const { promises: fs } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { afterEach, describe, it } = require('mocha')
const { CacheError, CacheManager, parseCommit } = require('../app/ops/cache')

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const roots = []

async function temporaryRoot () {
  const root = await fs.mkdtemp(join(tmpdir(), 'ops-cache-'))
  roots.push(root)
  return root
}

async function entry (root, commit, content = 'data', complete = true) {
  const directory = join(root, commit)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(join(directory, 'content'), content)
  if (complete) await fs.writeFile(join(directory, '.complete'), '')
  return directory
}

function manager (root, options = {}) {
  return new CacheManager({ root, service: 'builder', idleExpiryMs: 1000, ...options })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

describe('operations cache', () => {
  it('inspects only complete canonical entries with exact bytes and deterministic idle data', async () => {
    const root = await temporaryRoot()
    await entry(root, A, '1234')
    await entry(root, B, 'ignored', false)
    await entry(root, 'not-a-commit', 'ignored')
    const time = Date.parse('2026-01-01T00:00:00.000Z')
    const cache = manager(root, { now: () => time })
    cache.touch(A)
    const snapshot = await cache.snapshot()
    assert.deepEqual(snapshot, {
      entryCount: 1,
      totalBytes: 4,
      idleExpiryMs: 1000,
      entriesTruncated: false,
      entries: [{
        commit: A,
        sizeBytes: 4,
        lastAccessedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-01T00:00:01.000Z',
        inUse: 0
      }]
    })
  })

  it('reuses sealed entry sizes and invalidates changed and replaced entries', async () => {
    const root = await temporaryRoot()
    const directory = await entry(root, A, '1234')
    let walks = 0
    const filesystem = Object.create(fs)
    filesystem.readdir = async (path, options) => {
      if (path.startsWith(directory)) walks++
      return fs.readdir(path, options)
    }
    const cache = manager(root, { filesystem })

    assert.equal((await cache.snapshot()).totalBytes, 4)
    assert.equal(walks, 1)
    assert.equal((await cache.snapshot()).totalBytes, 4)
    assert.equal(walks, 1)

    await fs.writeFile(join(directory, 'content'), '123456')
    await fs.utimes(join(directory, '.complete'), new Date(1), new Date(2))
    assert.equal((await cache.snapshot()).totalBytes, 6)
    assert.equal(walks, 2)

    await fs.rm(directory, { recursive: true })
    await entry(root, A, '12345678')
    assert.equal((await cache.snapshot()).totalBytes, 8)
    assert.equal(walks, 3)
  })

  it('tracks shared users and excludes active entries from deletion', async () => {
    const root = await temporaryRoot()
    await entry(root, A)
    let time = Date.parse('2026-01-01T00:00:00.000Z')
    const cache = manager(root, { now: () => time })
    const releaseOne = await cache.acquire(A)
    const releaseTwo = await cache.acquire(A)
    assert.equal((await cache.snapshot()).entries[0].inUse, 2)
    assert.deepEqual(await cache.execute('cache.evict_commit', A), {
      service: 'builder',
      outcome: 'no_op',
      removedEntries: 0,
      freedBytes: 0,
      absent: false,
      skippedInUse: 1,
      error: null,
      skippedChanged: 0
    })
    time += 500
    releaseOne()
    releaseTwo()
    assert.equal((await cache.snapshot()).entries[0].lastAccessedAt, '2026-01-01T00:00:00.500Z')
  })

  it('validates commit paths and ignores symlink entries and markers', async function () {
    const root = await temporaryRoot()
    const outside = await temporaryRoot()
    await entry(outside, A)
    try {
      await fs.symlink(join(outside, A), join(root, A), 'dir')
      await entry(root, B)
      await fs.rm(join(root, B, '.complete'))
      await fs.symlink(join(outside, A, '.complete'), join(root, B, '.complete'))
    } catch (error) {
      if (error.code === 'EPERM') return this.skip()
      throw error
    }
    assert.equal((await manager(root).snapshot()).entryCount, 0)
    assert.throws(() => parseCommit('../outside'), CacheError)
    assert.throws(() => parseCommit('A'.repeat(40)), CacheError)
    assert.equal((await fs.readFile(join(outside, A, 'content'), 'utf8')), 'data')
  })

  it('reports absent and deletes complete entries without touching incomplete ones', async () => {
    const root = await temporaryRoot()
    await entry(root, B, 'keep', false)
    const cache = manager(root)
    assert.equal((await cache.execute('cache.evict_commit', A)).absent, true)
    assert.equal((await cache.execute('cache.clear')).outcome, 'no_op')
    assert.equal(await fs.readFile(join(root, B, 'content'), 'utf8'), 'keep')
    await entry(root, A, 'gone')
    const result = await cache.execute('cache.evict_commit', A)
    assert.equal(result.outcome, 'completed')
    assert.equal(result.removedEntries, 1)
    assert.equal(result.freedBytes, 4)
    await assert.rejects(fs.lstat(join(root, A)), { code: 'ENOENT' })
  })

  it('rechecks idle use under the deletion claim and maps mixed results to partial', async () => {
    const root = await temporaryRoot()
    await entry(root, A)
    await entry(root, B)
    let time = Date.parse('2026-01-01T00:00:00.000Z')
    const cache = manager(root, { now: () => time, concurrency: 1 })
    cache.touch(A)
    cache.touch(B)
    time += 1000
    const original = cache.deleteEntry.bind(cache)
    cache.deleteEntry = async (candidate, operation, threshold) => {
      if (candidate.commit === A) cache.touch(B)
      return original(candidate, operation, threshold)
    }
    const result = await cache.execute('cache.purge_expired')
    assert.equal(result.outcome, 'partial')
    assert.equal(result.removedEntries, 1)
    assert.equal(result.skippedChanged, 1)
    assert.equal((await cache.snapshot()).entries[0].commit, B)
  })

  it('serializes competing deleters and lets new users rebuild after deletion', async () => {
    const root = await temporaryRoot()
    await entry(root, A)
    const cache = manager(root)
    const [first, second] = await Promise.all([
      cache.execute('cache.evict_commit', A),
      cache.execute('cache.evict_commit', A)
    ])
    assert.equal(first.removedEntries + second.removedEntries, 1)
    assert.equal(first.absent || second.absent, true)
    const release = await cache.acquire(A)
    release()
  })

  it('bounds visible snapshots, scan work, and deletion concurrency', async () => {
    const root = await temporaryRoot()
    for (const commit of [A, B, C]) await entry(root, commit)
    let active = 0
    let maximum = 0
    const filesystem = Object.create(fs)
    filesystem.rm = async (...args) => {
      active++
      maximum = Math.max(maximum, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      try { return await fs.rm(...args) } finally { active-- }
    }
    const cache = manager(root, { entryLimit: 2, concurrency: 2, filesystem })
    const snapshot = await cache.snapshot()
    assert.equal(snapshot.entryCount, 3)
    assert.equal(snapshot.entries.length, 2)
    assert.equal(snapshot.entriesTruncated, true)
    assert.equal((await cache.execute('cache.clear')).removedEntries, 3)
    assert.equal(maximum, 2)

    const limitedRoot = await temporaryRoot()
    await entry(limitedRoot, A)
    await assert.rejects(manager(limitedRoot, { scanLimit: 1 }).snapshot(), error => error.code === 'CACHE_SCAN_LIMIT')
  })

  it('returns sanitized failed outcomes and rejects unnamed operations', async () => {
    const root = await temporaryRoot()
    await entry(root, A)
    const filesystem = Object.create(fs)
    filesystem.rename = async () => { throw new Error(`secret path: ${root}`) }
    const result = await manager(root, { filesystem }).execute('cache.evict_commit', A)
    assert.equal(result.outcome, 'failed')
    assert.deepEqual(result.error, { code: 'CACHE_OPERATION_FAILED', message: 'Cache operation failed' })
    assert.doesNotMatch(JSON.stringify(result), new RegExp(root))
    await assert.rejects(manager(root).execute('cache.delete', A), error => error.code === 'INVALID_OPERATION')
  })
})
