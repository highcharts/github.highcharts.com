'use strict'

const { expect } = require('chai')
const fs = require('fs')
const http = require('http')
const os = require('os')
const { join } = require('path')
const { execFileSync } = require('child_process')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')
const download = require('../app/download')
const { createDownloaderService, ESBUILD_DETECTION_TIMEOUT, OPTIONAL_SOURCE_PATHS, SOURCE_PATHS } = require('../app/downloader-service')
const { createApp, start } = require('../downloader-server')

const SHA = '0123456789abcdef0123456789abcdef01234567'

function deferred () {
  const result = {}
  result.promise = new Promise((resolve, reject) => {
    Object.assign(result, { reject, resolve })
  })
  return result
}

function request (app, path, options = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const req = http.request({
        port: server.address().port,
        path,
        method: options.method || 'GET',
        headers: options.headers || {}
      }, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          server.close()
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        })
      })
      req.on('error', reject)
      if (options.body) req.end(JSON.stringify(options.body))
      else req.end()
    })
  })
}

describe('downloader service', () => {
  let cacheRoot

  beforeEach(async () => {
    cacheRoot = await fs.promises.mkdtemp(join(os.tmpdir(), 'downloader-'))
    download.__clearGitHubCache()
    download.__clearRateLimitState()
  })

  afterEach(async () => {
    if (download.downloadSourceFolder.restore) download.downloadSourceFolder.restore()
    if (download.downloadFile.restore) download.downloadFile.restore()
    download.__setGitHubRequest()
    await fs.promises.rm(cacheRoot, { recursive: true, force: true })
  })

  it('exposes unauthenticated health and protects all v1 routes', async () => {
    const service = {
      resolveRef: sinon.stub(),
      snapshot: sinon.stub(),
      cacheManager: { execute: sinon.stub() }
    }
    const app = createApp({ token: 'secret', service })
    const unauthorized = { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }
    expect((await request(app, '/health')).status).to.equal(200)
    for (const authorization of [undefined, 'Basic secret', 'Bearer ', 'Bearer x', 'Bearer wrong!', 'Bearer secrets']) {
      const headers = authorization === undefined ? {} : { Authorization: authorization }
      for (const [path, method] of [['/v1/resolve', 'POST'], ['/v1/ops/snapshot', 'GET']]) {
        const response = await request(app, path, { method, headers })
        expect(response.status).to.equal(401)
        expect(JSON.parse(response.body)).to.deep.equal(unauthorized)
      }
    }
    expect(service.resolveRef.callCount).to.equal(0)
    expect(service.snapshot.callCount).to.equal(0)
    expect(service.cacheManager.execute.callCount).to.equal(0)
  })

  it('fails startup without an internal service token', () => {
    const token = process.env.INTERNAL_SERVICE_TOKEN
    try {
      delete process.env.INTERNAL_SERVICE_TOKEN
      expect(() => start()).to.throw('INTERNAL_SERVICE_TOKEN is required')
      process.env.INTERNAL_SERVICE_TOKEN = ''
      expect(() => start()).to.throw('INTERNAL_SERVICE_TOKEN is required')
    } finally {
      if (token === undefined) delete process.env.INTERNAL_SERVICE_TOKEN
      else process.env.INTERNAL_SERVICE_TOKEN = token
    }
  })

  it('resolves a canonical SHA with cached v13 detection and rate metadata', async () => {
    const reset = Math.floor(Date.now() / 1000) + 60
    const github = sinon.stub().resolves({
      statusCode: 200,
      body: JSON.stringify({ commit: { sha: SHA } }),
      headers: { 'x-ratelimit-remaining': '12', 'x-ratelimit-reset': String(reset) }
    })
    const fetch = sinon.stub().resolves({ ok: true, status: 200 })
    download.__setGitHubRequest(github)
    const service = createDownloaderService({ cacheRoot, fetch })

    const first = await service.resolveRef('feature')
    const second = await service.resolveRef('feature')

    expect(first).to.deep.equal({
      commit: SHA,
      needsEsbuild: true,
      rate: { remaining: 12, reset, limited: false, retryAfter: undefined }
    })
    expect(second.commit).to.equal(SHA)
    expect(github.callCount).to.equal(1)
    expect(fetch.callCount).to.equal(1)
    expect(fetch.firstCall.args[1].method).to.equal('HEAD')
  })

  it('stops after an exhausted branch lookup and returns structured rate metadata', async () => {
    const reset = Math.floor(Date.now() / 1000) + 60
    const github = sinon.stub().resolves({
      statusCode: 403,
      headers: {
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(reset)
      }
    })
    download.__setGitHubRequest(github)
    const app = createApp({ token: 'secret', cacheRoot })

    const response = await request(app, '/v1/resolve', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: { ref: 'feature' }
    })

    expect(response.status).to.equal(429)
    expect(JSON.parse(response.body)).to.deep.equal({ error: { code: 'RATE_LIMITED', message: 'GitHub rate limit is exhausted' } })
    expect(response.headers).to.include({
      'x-github-ratelimit-limit': '5000',
      'x-github-ratelimit-remaining': '0',
      'x-github-ratelimit-reset': String(reset)
    })
    expect(github.callCount).to.equal(1)
  })

  it('falls back from a genuine missing branch to commit lookup', async () => {
    const github = sinon.stub()
    github.onFirstCall().resolves({ statusCode: 404, headers: {} })
    github.onSecondCall().resolves({ statusCode: 200, body: JSON.stringify({ sha: SHA }), headers: {} })
    download.__setGitHubRequest(github)

    const result = await createDownloaderService({ cacheRoot, fetch: sinon.stub().resolves({ ok: false, status: 404 }) }).resolveRef('deadbeef')

    expect(result.commit).to.equal(SHA)
    expect(github.callCount).to.equal(2)
    expect(github.secondCall.args[0].path).to.include('/commits/deadbeef')
  })

  it('returns structured timeout errors', async () => {
    const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      let fetchStarted
      const started = new Promise(resolve => { fetchStarted = resolve })
      const fetch = (url, options) => new Promise((resolve, reject) => {
        fetchStarted()
        options.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
      const service = createDownloaderService({ cacheRoot, fetch })
      const pending = service.needsEsbuild(SHA).catch(error => error)
      await started
      clock.tick(ESBUILD_DETECTION_TIMEOUT - 1)
      expect(await Promise.race([pending, Promise.resolve('pending')])).to.equal('pending')
      clock.tick(1)
      const error = await pending
      expect(error).to.include({ code: 'UPSTREAM_TIMEOUT', status: 504 })
    } finally {
      clock.restore()
    }
  })

  it('shares one concurrent esbuild detection request and success', async () => {
    const started = deferred()
    const response = deferred()
    const fetch = sinon.stub().callsFake(() => {
      started.resolve()
      return response.promise
    })
    const service = createDownloaderService({ cacheRoot, fetch })

    const first = service.needsEsbuild(SHA)
    const second = service.needsEsbuild(SHA)
    await started.promise
    expect(fetch.callCount).to.equal(1)
    response.resolve({ ok: true, status: 200 })

    expect(await Promise.all([first, second])).to.deep.equal([true, true])
    expect(fetch.callCount).to.equal(1)
  })

  it('shares sanitized esbuild failures and retries after failure', async () => {
    const started = deferred()
    const response = deferred()
    const fetch = sinon.stub()
    fetch.onFirstCall().callsFake(() => {
      started.resolve()
      return response.promise
    })
    fetch.onSecondCall().resolves({ ok: false, status: 404 })
    const service = createDownloaderService({ cacheRoot, fetch })

    const first = service.needsEsbuild(SHA).catch(error => error)
    const second = service.needsEsbuild(SHA).catch(error => error)
    await started.promise
    expect(fetch.callCount).to.equal(1)
    response.reject(new Error('sensitive upstream failure'))
    const errors = await Promise.all([first, second])

    expect(errors[0]).to.equal(errors[1])
    expect(errors[0]).to.include({ code: 'UPSTREAM_ERROR', status: 502, message: 'GitHub request failed' })
    expect(await service.needsEsbuild(SHA)).to.equal(false)
    expect(fetch.callCount).to.equal(2)
  })

  it('creates absent optional roots and marks complete only after success', async () => {
    const source = sinon.stub(download, 'downloadSourceFolder').callsFake(async root => {
      await fs.promises.mkdir(join(root, 'ts'), { recursive: true })
      await fs.promises.mkdir(join(root, 'css'), { recursive: true })
      return []
    })
    const service = createDownloaderService({ cacheRoot })

    const root = await service.ensureSource(SHA)

    expect(source.callCount).to.equal(1)
    for (const path of OPTIONAL_SOURCE_PATHS) expect(fs.existsSync(join(root, path))).to.equal(true)
    expect(fs.existsSync(join(root, '.complete'))).to.equal(true)
  })

  it('shares one concurrent source population attempt and success', async () => {
    const started = deferred()
    const downloadComplete = deferred()
    const source = sinon.stub(download, 'downloadSourceFolder').callsFake(async root => {
      started.resolve()
      await downloadComplete.promise
      await fs.promises.mkdir(join(root, 'ts'), { recursive: true })
      await fs.promises.mkdir(join(root, 'css'), { recursive: true })
      return []
    })
    const service = createDownloaderService({ cacheRoot })

    const first = service.ensureSource(SHA)
    const second = service.ensureSource(SHA)
    await started.promise
    expect(source.callCount).to.equal(1)
    downloadComplete.resolve()

    expect(await Promise.all([first, second])).to.deep.equal([join(cacheRoot, SHA), join(cacheRoot, SHA)])
    expect(source.callCount).to.equal(1)
  })

  it('shares sanitized source failures and retries after failure', async () => {
    const started = deferred()
    const downloadComplete = deferred()
    const source = sinon.stub(download, 'downloadSourceFolder')
    source.onFirstCall().callsFake(async () => {
      started.resolve()
      await downloadComplete.promise
      throw new Error('sensitive source failure')
    })
    source.onSecondCall().callsFake(async root => {
      await fs.promises.mkdir(join(root, 'ts'), { recursive: true })
      await fs.promises.mkdir(join(root, 'css'), { recursive: true })
      return []
    })
    const service = createDownloaderService({ cacheRoot })

    const first = service.ensureSource(SHA).catch(error => error)
    const second = service.ensureSource(SHA).catch(error => error)
    await started.promise
    expect(source.callCount).to.equal(1)
    downloadComplete.resolve()
    const errors = await Promise.all([first, second])

    expect(errors[0]).to.equal(errors[1])
    expect(errors[0]).to.include({ code: 'INTERNAL_ERROR', status: 500, message: 'An internal error occurred' })
    expect(await service.ensureSource(SHA)).to.equal(join(cacheRoot, SHA))
    expect(source.callCount).to.equal(2)
  })

  it('removes partial source and does not mark complete after failure', async () => {
    const root = join(cacheRoot, SHA)
    const file = join(root, '.files', 'js/sample.js')
    await fs.promises.mkdir(join(file, '..'), { recursive: true })
    await fs.promises.writeFile(file, 'cached file')
    await fs.promises.writeFile(join(root, '.complete'), '')
    sinon.stub(download, 'downloadSourceFolder').callsFake(async root => {
      await fs.promises.mkdir(join(root, 'ts'), { recursive: true })
      throw Object.assign(new Error('forbidden'), { statusCode: 403 })
    })
    const service = createDownloaderService({ cacheRoot })
    let error

    try { await service.ensureSource(SHA) } catch (e) { error = e }

    expect(error).to.include({ code: 'INTERNAL_ERROR', status: 500, message: 'An internal error occurred' })
    expect(fs.existsSync(join(root, 'ts'))).to.equal(false)
    expect(fs.existsSync(join(root, '.source-complete'))).to.equal(false)
    expect(fs.existsSync(join(root, '.complete'))).to.equal(true)
    expect(await fs.promises.readFile(file, 'utf8')).to.equal('cached file')
  })

  it('rejects invalid SHAs, unsafe paths, and retains queue-full identity', async () => {
    const service = createDownloaderService({
      cacheRoot,
      queue: { addJob: () => Promise.reject(Object.assign(new Error('full'), { name: 'QueueFullError' })) }
    })
    for (const [commit, path, code] of [['short', 'js/a.js', 'INVALID_COMMIT'], [SHA, '../secret', 'INVALID_PATH']]) {
      let error
      try { await service.openFile(commit, path) } catch (e) { error = e }
      expect(error.code).to.equal(code)
    }
    let queueError
    try { await service.ensureSource(SHA) } catch (e) { queueError = e }
    expect(queueError).to.include({ name: 'QueueFullError', code: 'QUEUE_FULL' })
  })

  it('streams immutable raw files', async () => {
    for (const path of SOURCE_PATHS) await fs.promises.mkdir(join(cacheRoot, SHA, path), { recursive: true })
    await fs.promises.writeFile(join(cacheRoot, SHA, '.complete'), '')
    await fs.promises.writeFile(join(cacheRoot, SHA, 'js/sample.js'), 'raw source')
    const app = createApp({ token: 'secret', cacheRoot })
    const response = await request(app, `/v1/files/${SHA}/js/sample.js`, {
      headers: { Authorization: 'Bearer secret' }
    })
    expect(response.status).to.equal(200)
    expect(response.body.toString()).to.equal('raw source')
    expect(response.headers['cache-control']).to.include('immutable')
  })

  it('downloads only a missing static file and reuses its cache', async () => {
    const source = sinon.stub(download, 'downloadSourceFolder')
    const file = sinon.stub(download, 'downloadFile').callsFake(async (url, path) => {
      await fs.promises.mkdir(join(path, '..'), { recursive: true })
      await fs.promises.writeFile(path, 'raw source')
      return { statusCode: 200, success: true, url }
    })
    const service = createDownloaderService({ cacheRoot })

    for (let i = 0; i < 2; ++i) {
      const stream = await service.openFile(SHA.toUpperCase(), 'js/sample.js')
      const chunks = []
      for await (const chunk of stream) chunks.push(chunk)
      expect(Buffer.concat(chunks).toString()).to.equal('raw source')
    }

    expect(file.callCount).to.equal(1)
    expect(file.firstCall.args[0]).to.match(new RegExp(`${SHA}/js/sample\\.js$`))
    expect(source.callCount).to.equal(0)
    expect(fs.existsSync(join(cacheRoot, SHA, '.complete'))).to.equal(true)
  })

  it('preserves static file upstream errors', async () => {
    sinon.stub(download, 'downloadFile').resolves({ statusCode: 403, success: false })
    const service = createDownloaderService({ cacheRoot })
    let error

    try { await service.openFile(SHA, 'js/sample.js') } catch (e) { error = e }

    expect(error).to.include({ code: 'UPSTREAM_ERROR', status: 502, message: 'GitHub request failed' })
    expect(download.getRateLimitState()).to.deep.equal({ remaining: undefined, reset: undefined, limited: false, retryAfter: undefined })
  })

  it('archives exactly the source paths and extracts them without a wrapper', async () => {
    for (const path of SOURCE_PATHS) {
      await fs.promises.mkdir(join(cacheRoot, SHA, path), { recursive: true })
      await fs.promises.writeFile(join(cacheRoot, SHA, path, 'sample.txt'), path)
    }
    await fs.promises.writeFile(join(cacheRoot, SHA, '.complete'), '')
    const service = createDownloaderService({ cacheRoot })
    const tar = await service.archive(SHA)
    const closed = new Promise(resolve => tar.on('close', resolve))
    const chunks = []
    for await (const chunk of tar.stdout) chunks.push(chunk)
    expect(await closed).to.equal(0)
    const archive = join(cacheRoot, 'source.tar.gz')
    await fs.promises.writeFile(archive, Buffer.concat(chunks))
    const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n')
    const roots = [...new Set(entries.filter(path => path.endsWith('sample.txt')).map(path => path.split('/').slice(0, path.startsWith('tools/') ? 2 : 1).join('/')))]
    expect(roots).to.have.members(SOURCE_PATHS)
    const extracted = join(cacheRoot, 'extracted')
    await fs.promises.mkdir(extracted)
    execFileSync('tar', ['-xzf', archive, '-C', extracted])
    expect(await fs.promises.readFile(join(extracted, 'tools/libs/sample.txt'), 'utf8')).to.equal('tools/libs')
  })

  it('cleans only expired downloader cache entries', async () => {
    const old = join(cacheRoot, SHA)
    await fs.promises.mkdir(join(old, '.files'), { recursive: true })
    await fs.promises.writeFile(join(old, '.files', 'cached'), 'data')
    await fs.promises.writeFile(join(old, '.complete'), '')
    const timestamp = new Date(Date.now() - 10000)
    await fs.promises.utimes(old, timestamp, timestamp)
    await fs.promises.utimes(join(old, '.complete'), timestamp, timestamp)
    const service = createDownloaderService({ cacheRoot, cacheLifetime: 1 })
    expect(await service.cleanup()).to.deep.equal([SHA])
    expect(fs.existsSync(old)).to.equal(false)
  })

  it('exposes a bounded authenticated ops snapshot and named cache operations', async () => {
    const root = join(cacheRoot, SHA)
    await fs.promises.mkdir(join(root, '.files'), { recursive: true })
    await fs.promises.writeFile(join(root, '.files', 'cached'), 'data')
    await fs.promises.writeFile(join(root, '.complete'), '')
    const app = createApp({ token: 'secret', cacheRoot })

    const snapshot = await request(app, '/v1/ops/snapshot', {
      headers: { Authorization: 'Bearer secret', 'X-Correlation-ID': 'snapshot-id' }
    })
    expect(snapshot.status).to.equal(200)
    expect(snapshot.headers['x-correlation-id']).to.equal('snapshot-id')
    expect(JSON.parse(snapshot.body)).to.include({ schemaVersion: 1, service: 'downloader' })
    expect(JSON.parse(snapshot.body).cache.entries[0].commit).to.equal(SHA)

    const operation = await request(app, '/v1/ops/cache-operations', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: { operation: 'cache.evict_commit', targets: ['downloader'], commit: SHA }
    })
    expect(operation.status).to.equal(200)
    expect(JSON.parse(operation.body).targets[0]).to.include({ service: 'downloader', outcome: 'completed', removedEntries: 1 })
  })

  it('keeps a complete logical entry in use for the full file response lifetime', async () => {
    const root = join(cacheRoot, SHA)
    for (const path of SOURCE_PATHS) await fs.promises.mkdir(join(root, path), { recursive: true })
    await fs.promises.writeFile(join(root, 'js/sample.js'), 'raw source')
    await fs.promises.writeFile(join(root, '.complete'), '')
    const service = createDownloaderService({ cacheRoot })

    const stream = await service.openFile(SHA, 'js/sample.js')
    expect((await service.cacheManager.snapshot()).entries[0].inUse).to.equal(1)
    expect(await service.cacheManager.execute('cache.evict_commit', SHA)).to.include({ outcome: 'no_op', skippedInUse: 1 })
    for await (const chunk of stream) expect(chunk.toString()).to.equal('raw source')
    expect(await service.cacheManager.execute('cache.evict_commit', SHA)).to.include({ outcome: 'completed', removedEntries: 1 })
  })
})
