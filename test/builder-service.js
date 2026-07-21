'use strict'

const { expect } = require('chai')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const { EventEmitter } = require('node:events')
const { join } = require('node:path')
const { PassThrough, Readable } = require('node:stream')
const { gzipSync } = require('node:zlib')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')
const { createBuilder } = require('../app/build')
const { buildDashboards } = require('../app/dashboards')
const { createBuilderService, SOURCE_PATHS, validateRequest } = require('../app/builder-service')
const { createServiceClient } = require('../app/service-client')
const { createApp, start } = require('../builder-server')
const config = require('../config.json')

const SHA = '0123456789abcdef0123456789abcdef01234567'

function tarArchive (entries) {
  const blocks = []
  for (const entry of entries) {
    const data = Buffer.from(entry.data || '')
    const header = Buffer.alloc(512)
    let name = entry.name
    let prefix = ''
    if (Buffer.byteLength(name) > 100) {
      const slash = name.lastIndexOf('/', 155)
      prefix = name.slice(0, slash)
      name = name.slice(slash + 1)
    }
    header.write(name, 0, 100)
    header.write('0000755\0', 100, 8)
    header.write('0000000\0', 108, 8)
    header.write('0000000\0', 116, 8)
    header.write(`${(entry.size === undefined ? data.length : entry.size).toString(8).padStart(11, '0')}\0`, 124, 12)
    header.write('00000000000\0', 136, 12)
    header.fill(32, 148, 156)
    header[156] = (entry.type || (entry.name.endsWith('/') ? '5' : '0')).charCodeAt(0)
    header.write('ustar\0', 257, 6)
    header.write('00', 263, 2)
    header.write(prefix, 345, 155)
    let checksum = 0
    for (const byte of header) checksum += byte
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8)
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

function sourceArchive (extra = []) {
  return tarArchive([
    ...SOURCE_PATHS.map(name => ({ name: `${name}/`, type: '5' })),
    { name: 'ts/sample', data: 'source' },
    ...extra
  ])
}

async function expectArchiveFailure (cacheRoot, archive, options = {}) {
  const service = createBuilderService({ cacheRoot, client: { stream: () => Readable.from(archive) }, builder: {}, ...options })
  let error
  try { await service.ensureSource(SHA) } catch (caught) { error = caught }
  expect(error).to.include({ code: options.code || 'ARCHIVE_ERROR', status: options.status || 502 })
  expect(await fs.promises.readdir(cacheRoot)).to.deep.equal([])
}

function request (app, path, options = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const req = http.request({ port: server.address().port, path, method: options.method || 'GET', headers: options.headers }, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          server.close()
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        })
      })
      req.on('error', reject)
      req.end(options.body === undefined ? undefined : JSON.stringify(options.body))
    })
  })
}

describe('builder service', () => {
  let cacheRoot
  let sourceRoot

  beforeEach(async () => {
    cacheRoot = await fs.promises.mkdtemp(join(os.tmpdir(), 'builder-'))
    sourceRoot = await fs.promises.mkdtemp(join(os.tmpdir(), 'builder-source-'))
  })

  afterEach(async () => {
    await fs.promises.rm(cacheRoot, { recursive: true, force: true })
    await fs.promises.rm(sourceRoot, { recursive: true, force: true })
  })

  it('exposes health without auth and protects every v1 route', async () => {
    const service = {
      build: sinon.stub(),
      snapshot: sinon.stub(),
      cacheManager: { execute: sinon.stub() }
    }
    const app = createApp({ token: 'secret', service })
    const unauthorized = { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }
    expect((await request(app, '/health')).status).to.equal(200)
    for (const authorization of [undefined, 'Basic secret', 'Bearer ', 'Bearer x', 'Bearer wrong!', 'Bearer secrets']) {
      const headers = authorization === undefined ? {} : { Authorization: authorization }
      for (const [path, method] of [['/v1/build', 'POST'], ['/v1/ops/snapshot', 'GET']]) {
        const response = await request(app, path, { method, headers })
        expect(response.status).to.equal(401)
        expect(JSON.parse(response.body)).to.deep.equal(unauthorized)
      }
    }
    expect(service.build.callCount).to.equal(0)
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

  it('validates canonical commits, normalized paths, modes, and options', () => {
    expect(validateRequest({ commit: SHA, path: 'modules/exporting.src.js', mode: 'legacy' })).to.include({ commit: SHA, path: 'modules/exporting.src.js', mode: 'legacy' })
    expect(validateRequest({ commit: SHA, path: 'a.js', mode: 'webpack' }).options).to.deep.equal({})
    for (const config of ['highcharts.webpack.mjs', 'custom-1.webpack_mjs']) {
      expect(validateRequest({ commit: SHA, path: 'a.js', mode: 'webpack', options: { config } }).options.config).to.equal(config)
    }
    for (const body of [
      { commit: SHA.toUpperCase(), path: 'a.js', mode: 'legacy' },
      { commit: SHA, path: '../a.js', mode: 'legacy' },
      { commit: SHA, path: 'a//b.js', mode: 'legacy' },
      { commit: SHA, path: 'a.js', mode: 'auto' },
      { commit: SHA, path: 'a.js', mode: 'legacy', options: [] }
    ]) expect(() => validateRequest(body)).to.throw()
  })

  it('rejects unsafe webpack configs before invoking the builder', async () => {
    const builder = { build: sinon.stub() }
    const service = createBuilderService({ cacheRoot, client: {}, builder })
    const invalidConfigs = [null, 1, {}, [], '../config.mjs', '/config.mjs', 'dir/config.mjs', 'dir\\config.mjs', 'config file.mjs', 'config\nfile.mjs', 'config;touch.mjs', 'config$(id).mjs', 'a'.repeat(129)]
    for (const config of invalidConfigs) {
      let error
      try { await service.build({ commit: SHA, path: 'a.js', mode: 'webpack', options: { config } }) } catch (e) { error = e }
      expect(error).to.include({ code: 'INVALID_OPTIONS', status: 400, message: 'Build options are invalid' })
    }
    expect(builder.build.callCount).to.equal(0)
  })

  it('executes webpack with the config as one argument and no shell', async () => {
    const childProcess = require('node:child_process')
    const execFile = sinon.stub(childProcess, 'execFile').callsFake((file, args, options, callback) => callback(null, { stdout: '', stderr: '' }))
    const utilsPath = require.resolve('../app/utils')
    delete require.cache[utilsPath]
    try {
      const { compileWebpack } = require('../app/utils')
      await compileWebpack('/workspace', 'custom.webpack.mjs')
      expect(execFile.firstCall.args.slice(0, 3)).to.deep.equal([
        'npx',
        ['webpack', '-c', join('tools/webpacks', 'custom.webpack.mjs'), '--stats', 'errors-only'],
        { timeout: 15000, cwd: '/workspace', shell: false }
      ])
    } finally {
      execFile.restore()
      delete require.cache[utilsPath]
    }
  })

  it('streams an archive into tar, validates roots, atomically caches, and hits cache', async () => {
    for (const path of SOURCE_PATHS) {
      await fs.promises.mkdir(join(sourceRoot, path), { recursive: true })
      await fs.promises.writeFile(join(sourceRoot, path, 'sample'), path)
    }
    const archive = join(sourceRoot, 'source.tar.gz')
    execFileSync('tar', ['--format', 'ustar', '-czf', archive, '--', ...SOURCE_PATHS], { cwd: sourceRoot, env: { ...process.env, COPYFILE_DISABLE: '1' } })
    const client = { stream: sinon.stub().callsFake(() => fs.createReadStream(archive)) }
    const service = createBuilderService({ cacheRoot, client, builder: {} })
    expect(await service.ensureSource(SHA)).to.equal(join(cacheRoot, SHA))
    expect(await fs.promises.readFile(join(cacheRoot, SHA, 'tools/libs/sample'), 'utf8')).to.equal('tools/libs')
    await service.ensureSource(SHA)
    expect(client.stream.callCount).to.equal(1)
    expect((await fs.promises.readdir(cacheRoot)).filter(name => name.startsWith('.extract-'))).to.have.length(0)
  })

  it('removes partial extraction after required-root failure', async () => {
    await fs.promises.mkdir(join(sourceRoot, 'ts'))
    const archive = join(sourceRoot, 'bad.tar.gz')
    execFileSync('tar', ['--format', 'ustar', '-czf', archive, 'ts'], { cwd: sourceRoot, env: { ...process.env, COPYFILE_DISABLE: '1' } })
    const service = createBuilderService({ cacheRoot, client: { stream: () => fs.createReadStream(archive) }, builder: {} })
    let error
    try { await service.ensureSource(SHA) } catch (e) { error = e }
    expect(error.code).to.equal('SOURCE_INCOMPLETE')
    expect(await fs.promises.readdir(cacheRoot)).to.have.length(0)
  })

  it('rejects compressed and inflated archive overflows without promotion', async () => {
    await expectArchiveFailure(cacheRoot, Buffer.alloc(32 * 1024 * 1024 + 1))
    const files = Array.from({ length: 17 }, (_, index) => ({ name: `ts/large-${index}`, data: Buffer.alloc(4 * 1024 * 1024) }))
    await expectArchiveFailure(cacheRoot, sourceArchive(files))
  })

  it('rejects excessive entries and regular files without promotion', async () => {
    await expectArchiveFailure(cacheRoot, sourceArchive([{ name: 'ts/large', size: 4 * 1024 * 1024 + 1 }]))
    const entries = Array.from({ length: 5001 }, (_, index) => ({ name: `ts/e-${index}`, data: '' }))
    await expectArchiveFailure(cacheRoot, tarArchive(entries))
  })

  it('rejects non-canonical, duplicate, and disallowed archive paths', async () => {
    for (const entries of [
      [{ name: '../escape', data: '' }],
      [{ name: '/absolute', data: '' }],
      [{ name: 'ts\\backslash', data: '' }],
      [{ name: 'ts//empty', data: '' }],
      [{ name: 'ts/./dot', data: '' }],
      [{ name: 'ts/../escape', data: '' }],
      [{ name: 'ts/duplicate', data: '' }, { name: 'ts/duplicate', data: '' }],
      [{ name: 'docs/readme', data: '' }]
    ]) await expectArchiveFailure(cacheRoot, tarArchive(entries))
  })

  it('rejects links, special entries, and unsupported tar extensions', async () => {
    for (const type of ['1', '2', '3', '4', '6', 'x', 'g', 'L', 'K', 'S']) {
      await expectArchiveFailure(cacheRoot, tarArchive([{ name: 'ts/unsupported', type }]))
    }
  })

  it('keeps the downloader timeout active after response headers', async () => {
    const fetch = (url, options) => {
      const body = new PassThrough()
      options.signal.addEventListener('abort', () => body.destroy(new Error('aborted')))
      return Promise.resolve({ ok: true, body })
    }
    const client = createServiceClient({ baseURL: 'http://downloader', token: 'secret', timeout: 5, fetch })
    const stream = await client.stream('/v1/source', { timeoutThroughBody: true })
    let error
    let bytes = 0
    try {
      for await (const chunk of stream) bytes += chunk.length
    } catch (caught) {
      error = caught
    }
    expect(bytes).to.equal(0)
    expect(error).to.include({ code: 'SERVICE_TIMEOUT', status: 504 })
  })

  it('rejects unsafe extracted nodes and sizes before promotion', async () => {
    const cases = [
      async root => fs.promises.symlink('/tmp', join(root, 'ts/link')),
      async root => execFileSync('mkfifo', [join(root, 'ts/fifo')]),
      async root => {
        await fs.promises.rm(join(root, 'ts'), { recursive: true })
        await fs.promises.writeFile(join(root, 'ts'), 'not a source directory')
      },
      async root => {
        for (let index = 0; index < 17; index++) {
          const file = await fs.promises.open(join(root, `ts/large-${index}`), 'w')
          await file.truncate(4 * 1024 * 1024)
          await file.close()
        }
      }
    ]
    for (const mutate of cases) {
      const spawn = (command, args) => {
        const child = new EventEmitter()
        child.stderr = new PassThrough()
        child.kill = sinon.stub()
        process.nextTick(async () => {
          try {
            const root = args[3]
            for (const path of SOURCE_PATHS) await fs.promises.mkdir(join(root, path), { recursive: true })
            await mutate(root)
            child.emit('close', 0)
          } catch (error) {
            child.emit('error', error)
          }
        })
        return child
      }
      await expectArchiveFailure(cacheRoot, sourceArchive(), { spawn })
    }
  })

  it('returns build metadata and structured failures', async () => {
    for (const path of SOURCE_PATHS) await fs.promises.mkdir(join(cacheRoot, SHA, path), { recursive: true })
    const output = join(cacheRoot, SHA, 'result.js')
    await fs.promises.writeFile(output, 'built')
    const service = createBuilderService({
      cacheRoot,
      client: {},
      builder: { build: sinon.stub().resolves({ file: output, builtWith: 'webpack' }) }
    })
    const app = createApp({ token: 'secret', service })
    const result = await request(app, '/v1/build', {
      method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: { commit: SHA, path: 'result.js', mode: 'webpack' }
    })
    expect(result.status).to.equal(200)
    expect(result.body.toString()).to.equal('built')
    expect(result.headers['x-built-with']).to.equal('webpack')
    expect(result.headers['x-correlation-id']).to.be.a('string')
    expect(fs.existsSync(join(cacheRoot, SHA, '.complete'))).to.equal(true)

    service.build = () => Promise.reject(Object.assign(new Error('full'), { name: 'QueueFullError', code: 'QUEUE_FULL', status: 503 }))
    const failed = await request(app, '/v1/build', { method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: {} })
    expect(failed.status).to.equal(503)
    expect(JSON.parse(failed.body).error.code).to.equal('QUEUE_FULL')
  })

  it('builds from the cache root configured by the service', async () => {
    const root = join(cacheRoot, SHA)
    for (const path of SOURCE_PATHS) await fs.promises.mkdir(join(root, path), { recursive: true })
    await fs.promises.mkdir(join(root, 'ts/masters'), { recursive: true })
    await fs.promises.writeFile(join(root, 'ts/tsconfig.json'), '{}')
    await fs.promises.writeFile(join(root, 'ts/masters/highcharts.src.ts'), '')
    const compile = sinon.stub().callsFake(async () => {
      await fs.promises.mkdir(join(root, 'js/masters'), { recursive: true })
      await fs.promises.writeFile(join(root, 'js/masters/highcharts.src.js'), '')
    })
    const service = createBuilderService({
      cacheRoot,
      client: {},
      queue: { addJob: (type, id, job) => job.func(...job.args) },
      dependencies: {
        compileTypeScript: compile,
        getFileNamesInDirectory: async () => ['highcharts.src.js'],
        getFileOptions: () => ({}),
        buildModules: () => {},
        buildDistFromModules: options => {
          fs.mkdirSync(options.output, { recursive: true })
          fs.writeFileSync(join(options.output, 'highcharts.src.js'), 'custom root')
        }
      }
    })

    const result = await service.build({ commit: SHA, path: 'highcharts.src.js', mode: 'legacy' })
    expect(await new Promise((resolve, reject) => {
      const chunks = []
      result.stream.on('data', chunk => chunks.push(chunk))
      result.stream.on('end', () => resolve(Buffer.concat(chunks).toString()))
      result.stream.on('error', reject)
    })).to.equal('custom root')
    expect(compile.callCount).to.equal(1)
    expect(compile.firstCall.args).to.deep.equal([SHA, 'masters/highcharts.src.ts', 'js', root])
  })

  it('passes the configured workspace to project TypeScript, esbuild, and Dashboards', async () => {
    const root = join(cacheRoot, SHA)
    await fs.promises.mkdir(join(root, 'ts'), { recursive: true })
    await fs.promises.writeFile(join(root, 'ts/tsconfig.json'), '{}')
    await fs.promises.writeFile(join(root, 'ts/project.src.ts'), '')
    const project = sinon.stub().resolves()
    const esbuild = sinon.stub().resolves({ file: join(root, 'output-esbuild/a.src.js'), status: 200 })
    const dashboards = sinon.stub().resolves(join(root, 'dashboards-output/a.js'))
    const builder = createBuilder({
      cacheRoot,
      queue: { addJob: (type, id, job) => job.func(...job.args) },
      dependencies: {
        compileTypeScriptProject: project,
        compileWithEsbuild: esbuild,
        buildDashboards: dashboards,
        getFileNamesInDirectory: async () => [],
        getFileOptions: () => ({}),
        buildModules: () => {},
        buildDistFromModules: () => fs.mkdirSync(join(root, 'output/masters'), { recursive: true })
      }
    })

    await builder.build({ commit: SHA, path: 'a.src.js', mode: 'esbuild' })
    await builder.build({ commit: SHA, path: 'a.js', mode: 'dashboards' })
    expect(esbuild.firstCall.args).to.deep.equal([SHA, 'a.src.js', { minify: false, workspaceRoot: root }])
    expect(dashboards.firstCall.args.slice(0, 3)).to.deep.equal([root, SHA, 'a.js'])

    const jobs = []
    await fs.promises.mkdir(join(root, 'ts/masters-dashboards'), { recursive: true })
    await fs.promises.writeFile(join(root, 'ts/masters-dashboards/a.src.ts'), '')
    await fs.promises.mkdir(join(root, 'js/masters-dashboards'), { recursive: true })
    await fs.promises.writeFile(join(root, 'js/masters-dashboards/a.js'), '')
    await buildDashboards(root, SHA, 'a.js', { addJob: (type, id, job) => jobs.push(job) })
    expect(jobs[0].args).to.deep.equal([SHA, 'masters-dashboards/a.src.js', 'js', root])

    await fs.promises.mkdir(join(root, 'output/masters'), { recursive: true })
    await fs.promises.writeFile(join(root, 'output/masters/project.src.js'), '')
    await builder.build({ commit: SHA, path: 'masters/project.src.js', mode: 'legacy' })
    expect(project.firstCall.args).to.deep.equal([SHA, root])
  })

  it('dispatches every explicit build mode, deduplicates legacy work, and preserves queue full', async () => {
    const root = join(__dirname, '../tmp', SHA)
    await fs.promises.rm(root, { recursive: true, force: true })
    await fs.promises.mkdir(join(root, 'ts/masters'), { recursive: true })
    await fs.promises.writeFile(join(root, 'ts/tsconfig.json'), '{}')
    await fs.promises.writeFile(join(root, 'ts/masters/highcharts.src.ts'), '')
    const compile = sinon.stub().callsFake(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      await fs.promises.mkdir(join(root, 'js/masters'), { recursive: true })
      await fs.promises.writeFile(join(root, 'js/masters/highcharts.src.js'), '')
    })
    const queue = { addJob: (type, id, job) => job.func(...job.args) }
    const writeOutput = path => async () => {
      await fs.promises.mkdir(join(root, path, '..'), { recursive: true })
      await fs.promises.writeFile(join(root, path), path)
      return { file: join(root, path), status: 200 }
    }
    const builder = createBuilder({
      queue,
      dependencies: {
        compileTypeScript: compile,
        getFileNamesInDirectory: async () => ['highcharts.src.js'],
        getFileOptions: () => ({}),
        buildModules: () => {},
        buildDistFromModules: () => {
          fs.mkdirSync(join(root, 'output'), { recursive: true })
          fs.writeFileSync(join(root, 'output/highcharts.src.js'), 'legacy')
        },
        compileWebpack: writeOutput('output/webpack.js'),
        buildDashboards: async () => (await writeOutput('dashboards-output/dashboards.js')()).file,
        compileWithEsbuild: writeOutput('output-esbuild/esbuild.src.js')
      }
    })
    try {
      const legacy = { commit: SHA, path: 'highcharts.src.js', mode: 'legacy' }
      const results = await Promise.all([builder.build(legacy), builder.build(legacy)])
      expect(results[0].builtWith).to.equal('assembler')
      expect(compile.callCount).to.equal(1)
      expect((await builder.build({ commit: SHA, path: 'webpack.js', mode: 'webpack' })).builtWith).to.equal('webpack')
      expect((await builder.build({ commit: SHA, path: 'dashboards.js', mode: 'dashboards' })).builtWith).to.equal('dashboards')
      expect((await builder.build({ commit: SHA, path: 'esbuild.src.js', mode: 'esbuild' })).builtWith).to.equal('esbuild')

      const full = createBuilder({ queue: { addJob: () => Promise.reject(Object.assign(new Error('full'), { name: 'QueueFullError' })) } })
      let error
      try { await full.build({ commit: SHA, path: 'webpack.js', mode: 'webpack' }) } catch (e) { error = e }
      expect(error).to.include({ name: 'QueueFullError', code: 'QUEUE_FULL', status: 503 })
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true })
    }
  })

  it('authenticates downloader requests and preserves timeout and service errors', async () => {
    const fetch = sinon.stub()
    fetch.onFirstCall().resolves({ ok: false, status: 503, headers: new Headers({ 'Retry-After': '2' }), json: async () => ({ error: { code: 'QUEUE_FULL', message: 'full' } }) })
    fetch.onSecondCall().callsFake((url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))))
    const client = createServiceClient({ baseURL: 'http://downloader', token: 'secret', timeout: 5, fetch })
    let error
    try { await client.stream('/v1/source') } catch (e) { error = e }
    expect(error).to.include({ name: 'QueueFullError', code: 'QUEUE_FULL', status: 503, retryAfter: '2' })
    expect(fetch.firstCall.args[1].headers.Authorization).to.equal('Bearer secret')
    try { await client.json('/v1/source') } catch (e) { error = e }
    expect(error).to.include({ code: 'SERVICE_TIMEOUT', status: 504 })
  })

  it('keeps the archive timeout separate from the fixed detection deadline', () => {
    expect(config.publicDownloaderTimeout).to.be.greaterThan(5000)
    expect(config.builderDownloaderTimeout).to.be.greaterThan(5000)
    expect(config.publicBuilderTimeout).to.be.greaterThan(config.builderDownloaderTimeout)
  })

  it('cleans only the builder cache', async () => {
    const path = join(cacheRoot, SHA)
    await fs.promises.mkdir(path)
    await fs.promises.writeFile(join(path, '.complete'), '')
    const service = createBuilderService({ cacheRoot, client: {}, builder: {}, cacheLifetime: 1 })
    const old = new Date(Date.now() - 10000)
    await fs.promises.utimes(path, old, old)
    await fs.promises.utimes(join(path, '.complete'), old, old)
    expect(await service.cleanup()).to.deep.equal([SHA])
    expect(fs.existsSync(sourceRoot)).to.equal(true)
  })

  it('exposes bounded operations data and protects active build cache entries', async () => {
    const root = join(cacheRoot, SHA)
    for (const path of SOURCE_PATHS) await fs.promises.mkdir(join(root, path), { recursive: true })
    const output = join(root, 'result.js')
    await fs.promises.writeFile(output, 'built')
    await fs.promises.writeFile(join(root, '.complete'), '')
    let finishBuild
    let markBuildStarted
    const buildStarted = new Promise(resolve => { markBuildStarted = resolve })
    const service = createBuilderService({
      cacheRoot,
      client: {},
      queue: { getMetrics: () => ({ active: 1, queued: 0, limit: 2, oldestQueuedAgeMs: null }) },
      builder: {
        build: () => new Promise(resolve => {
          finishBuild = () => resolve({ file: output, builtWith: 'webpack' })
          markBuildStarted()
        })
      }
    })
    const app = createApp({ token: 'secret', service })
    const building = request(app, '/v1/build', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json', 'X-Correlation-ID': 'builder-request' },
      body: { commit: SHA, path: 'result.js', mode: 'webpack' }
    })
    await buildStarted

    const operation = await request(app, '/v1/ops/cache-operations', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: { operation: 'cache.evict_commit', targets: ['builder'], commit: SHA }
    })
    expect(JSON.parse(operation.body).targets[0].skippedInUse).to.equal(1)
    finishBuild()
    await building

    const snapshot = await request(app, '/v1/ops/snapshot', { headers: { Authorization: 'Bearer secret' } })
    const body = JSON.parse(snapshot.body)
    expect(body).to.include({ schemaVersion: 1, service: 'builder' })
    expect(body.queues[0]).to.include({ name: 'build', active: 1, limit: 2 })
    expect(body.activity[0].request).to.deep.include({ commit: SHA, resource: null, buildMode: 'webpack' })
    expect(JSON.stringify(body)).not.to.include(cacheRoot)
  })
})
