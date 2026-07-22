const defaults = require('../app/download.js')
const { token } = require('../config.json')
const { expect } = require('chai')
const { EventEmitter } = require('events')
const fs = require('fs')
const https = require('https')
const { after, afterEach, before, describe, it } = require('mocha')
const sinon = require('sinon')

function loadDownloadWithHttpsGet (httpsGet) {
  const downloadPath = require.resolve('../app/download.js')
  const cachedDownload = require.cache[downloadPath]
  const originalHttpsGet = https.get

  delete require.cache[downloadPath]
  https.get = httpsGet
  try {
    return require('../app/download.js')
  } finally {
    https.get = originalHttpsGet
    delete require.cache[downloadPath]
    if (cachedDownload) {
      require.cache[downloadPath] = cachedDownload
    }
  }
}

function fakeHttpsGet (chunks, statusCode = 200, headers = {}) {
  return (options, callback) => {
    const request = new EventEmitter()
    request.end = () => {
      const response = new EventEmitter()
      response.statusCode = statusCode
      response.headers = headers
      callback(response)
      process.nextTick(() => {
        chunks.forEach(chunk => response.emit('data', chunk))
        response.emit('end')
      })
    }
    return request
  }
}

describe('download.js', () => {
  describe('exported properties', () => {
    const functions = [
      'downloadFile',
      'downloadFiles',
      'downloadSourceFolder',
      'downloadSourceFolderGit',
      'getDownloadFiles',
      'httpsGetPromise',
      'urlExists',
      'getBranchInfo',
      'getCommitInfo',
      'isRateLimited',
      'getRateLimitState',
      '__setGitHubRequest',
      '__clearGitHubCache',
      '__clearRateLimitState',
      '__setRateLimitState'
    ]
    it('should have a default export', () => {
      functions.forEach((name) => {
        expect(defaults).to.have.property(name)
          .that.is.a('function')
      })
    })
    it('should not have unexpected properties', () => {
      const exportedProperties = Object.keys(defaults)
      expect(exportedProperties).to.deep.equal(functions)
    })
  })

  describe('httpsGetPromise', () => {
    const { httpsGetPromise } = defaults
    const downloadURL = 'https://raw.githubusercontent.com/highcharts/highcharts/'
    it('should error if no options is provided', function () {
      this.timeout(5000)
      return httpsGetPromise()
        .then(() => { throw new Error('Promise resolved unexpectedly.') })
        .catch(e => {
          expect(e.message).to.not.equal('Promise resolved unexpectedly.')
        })
    })
    it('should return a response when a url is provided', () => {
      const body = '404: Not Found'
      const { httpsGetPromise } = loadDownloadWithHttpsGet(fakeHttpsGet([
        Buffer.from(body)
      ], 404))

      return httpsGetPromise(downloadURL)
        .then(({ body, statusCode }) => {
          expect(statusCode).to.equal(404)
          expect(body.toString('utf8')).to.equal('404: Not Found')
        })
    })
    it('should preserve arbitrary response bytes', async () => {
      const bytes = Buffer.from([0, 0xff, 0xfe, 0xfd, 0x61, 0xc3, 0x28])
      const { httpsGetPromise } = loadDownloadWithHttpsGet(fakeHttpsGet([
        bytes.subarray(0, 3),
        bytes.subarray(3)
      ]))

      const { body, statusCode } = await httpsGetPromise('https://example.test/binary')

      expect(statusCode).to.equal(200)
      expect(Buffer.isBuffer(body)).to.equal(true)
      expect(body.equals(bytes)).to.equal(true)
    })
  })

  describe('downloadFile', () => {
    const { downloadFile } = defaults
    const downloadURL = 'https://raw.githubusercontent.com/highcharts/highcharts/'
    const cleanFiles = () => {
      [
        'tmp/test/downloaded-file1.js',
        'tmp/test/downloaded-file2.js',
        'tmp/test/downloaded-binary.bin',
        'tmp/test'
      ].forEach(p => {
        try {
          const stat = fs.lstatSync(p)
          if (stat.isFile()) {
            fs.unlinkSync(p)
          } else if (stat.isDirectory()) {
            fs.rmdirSync(p)
          }
        } catch (err) {}
      })
    }
    after(cleanFiles)
    before(() => {
      cleanFiles()
      fs.mkdirSync('tmp/test', { recursive: true })
    })
    it('should resolve with an informational object, and a newly created file.', () => {
      const body = 'downloaded file content'
      const { downloadFile } = loadDownloadWithHttpsGet(fakeHttpsGet([
        Buffer.from(body)
      ]))

      return downloadFile(
        downloadURL + 'master/ts/masters/highcharts.src.ts',
        './tmp/test/downloaded-file1.js'
      ).then(({ outputPath, statusCode, success, url }) => {
        expect(outputPath).to.equal('./tmp/test/downloaded-file1.js')
        expect(statusCode).to.equal(200)
        expect(success).to.equal(true)
        expect(url).to.equal(downloadURL + 'master/ts/masters/highcharts.src.ts')
        expect(fs.lstatSync('./tmp/test/downloaded-file1.js').size).to.be.greaterThan(0)
        expect(fs.readFileSync('./tmp/test/downloaded-file1.js', 'utf8')).to.equal(body)
      })
    })
    it('should only create a file if response status is 200', () => {
      const { downloadFile } = loadDownloadWithHttpsGet(fakeHttpsGet([
        Buffer.from('404: Not Found')
      ], 404))

      return downloadFile(
        downloadURL + 'master/i-do-not-exist.js',
        './tmp/test/downloaded-file2.js'
      ).then(({ outputPath, statusCode, success, url }) => {
        let exists = true
        try {
          fs.lstatSync('./tmp/test/downloaded-file2.js')
        } catch (e) {
          exists = false
        }
        expect(statusCode).to.equal(404)
        expect(exists).to.equal(false)
      })
    })
    it('should reject when request is invalid', function () {
      this.timeout(5000)
      return downloadFile()
        .then(() => { throw new Error('Promise resolved unexpectedly.') })
        .catch(e => {
          expect(e.message).to.not.equal('Promise resolved unexpectedly.')
        })
    })
    it('should write arbitrary response bytes unchanged', async () => {
      const outputPath = './tmp/test/downloaded-binary.bin'
      const bytes = Buffer.from([0xde, 0xad, 0x00, 0xff, 0xfe, 0x62])
      const { downloadFile } = loadDownloadWithHttpsGet(fakeHttpsGet([
        bytes.subarray(0, 2),
        bytes.subarray(2)
      ]))

      const result = await downloadFile('https://example.test/binary', outputPath)

      expect(result).to.include({ outputPath, statusCode: 200, success: true })
      expect(fs.readFileSync(outputPath).equals(bytes)).to.equal(true)
    })
  })
  describe('downloadFiles', () => {
    it('is missing tests')
  })
  describe('downloadJSFolder', () => {
    /* TODO: pass in a mockup of https to the function to be able to test
       without an internet connection */
    it('is missing tests')
  })
  describe('getDownloadFiles', () => {
    const { __clearGitHubCache, __setGitHubRequest, getDownloadFiles } = defaults

    afterEach(() => {
      __setGitHubRequest()
      __clearGitHubCache()
    })

    it('allows root 404s only for optional source folders', async () => {
      const stub = sinon.stub().callsFake(({ path }) => Promise.resolve({
        statusCode: /\/contents\/(js|tools\/webpacks|tools\/libs)\?/.test(path) ? 404 : 200,
        body: Buffer.from('[]'),
        headers: {}
      }))
      __setGitHubRequest(stub)

      expect(await getDownloadFiles('modern')).to.deep.equal([])
      expect(stub.callCount).to.equal(5)
    })

    it('propagates required-root and non-404 upstream failures', async () => {
      for (const [failedPath, statusCode] of [['ts', 404], ['js', 403]]) {
        __setGitHubRequest(sinon.stub().callsFake(({ path }) => Promise.resolve({
          statusCode: path.includes(`/contents/${failedPath}?`) ? statusCode : 200,
          body: Buffer.from('[]'),
          headers: {}
        })))
        let error
        try { await getDownloadFiles('broken') } catch (e) { error = e }
        expect(error).to.include({ path: failedPath, statusCode })
      }
    })
  })
  describe('urlExists', () => {
    it('is missings tests')
  })

  describe('GitHub metadata caching', () => {
    const {
      __setGitHubRequest,
      __clearGitHubCache,
      getBranchInfo,
      getCommitInfo
    } = defaults

    afterEach(() => {
      __setGitHubRequest()
      __clearGitHubCache()
      delete process.env.GITHUB_TOKEN
    })

    it('reuses the same request for parallel branch lookups', async () => {
      const stub = sinon.stub().resolves({
        statusCode: 200,
        body: Buffer.from(JSON.stringify({ commit: { sha: 'abc123' } }))
      })

      __clearGitHubCache()
      __setGitHubRequest(stub)

      const [first, second] = await Promise.all([
        getBranchInfo('feature/test'),
        getBranchInfo('feature/test')
      ])

      expect(stub.callCount).to.equal(1)
      expect(first?.commit?.sha).to.equal('abc123')
      expect(second?.commit?.sha).to.equal('abc123')
    })

    it('returns cached commit info on subsequent calls', async () => {
      const stub = sinon.stub().resolves({
        statusCode: 200,
        body: Buffer.from(JSON.stringify({ sha: 'deadbeef' }))
      })

      __clearGitHubCache()
      __setGitHubRequest(stub)

      const first = await getCommitInfo('deadbeef')
      const second = await getCommitInfo('deadbeef')

      expect(stub.callCount).to.equal(1)
      expect(first?.sha).to.equal('deadbeef')
      expect(second?.sha).to.equal('deadbeef')
    })

    it('uses a non-empty environment token before the config token', async () => {
      const stub = sinon.stub().resolves({ statusCode: 404 })
      process.env.GITHUB_TOKEN = 'environment-token'
      __setGitHubRequest(stub)

      await getBranchInfo('environment-token-test')

      expect(stub.firstCall.args[0].headers.Authorization).to.equal('token environment-token')
    })

    it('falls back to the config token for an empty environment value', async () => {
      const stub = sinon.stub().resolves({ statusCode: 404 })
      process.env.GITHUB_TOKEN = ''
      __setGitHubRequest(stub)

      await getCommitInfo('config-token-test')

      expect(stub.firstCall.args[0].headers.Authorization).to.equal(`token ${token}`)
    })
  })

  describe('rate limiting', () => {
    const {
      isRateLimited,
      getRateLimitState,
      __clearRateLimitState,
      __setRateLimitState
    } = defaults

    afterEach(() => {
      __clearRateLimitState()
    })

    it('isRateLimited returns not limited by default', () => {
      const result = isRateLimited()
      expect(result.limited).to.equal(false)
      expect(result.retryAfter).to.equal(undefined)
    })

    it('getRateLimitState returns state object', () => {
      const state = getRateLimitState()
      expect(state).to.have.property('limited')
      expect(state).to.have.property('remaining')
      expect(state).to.have.property('reset')
      expect(state).to.have.property('retryAfter')
    })

    it('isRateLimited returns limited when remaining is 0 and reset is in future', () => {
      const futureReset = Math.floor(Date.now() / 1000) + 60 // 60 seconds in future
      __setRateLimitState(0, futureReset)

      const result = isRateLimited()
      expect(result.limited).to.equal(true)
      expect(result.retryAfter).to.be.a('number')
      expect(result.retryAfter).to.be.greaterThan(0)
      expect(result.reset).to.equal(futureReset)
    })

    it('isRateLimited clears state when reset time has passed', () => {
      const pastReset = Math.floor(Date.now() / 1000) - 10 // 10 seconds in past
      __setRateLimitState(0, pastReset)

      const result = isRateLimited()
      expect(result.limited).to.equal(false)

      // State should be cleared
      const state = getRateLimitState()
      expect(state.remaining).to.equal(undefined)
      expect(state.reset).to.equal(undefined)
    })

    it('isRateLimited returns not limited when remaining is greater than 0', () => {
      const futureReset = Math.floor(Date.now() / 1000) + 60
      __setRateLimitState(5, futureReset)

      const result = isRateLimited()
      expect(result.limited).to.equal(false)
    })
  })
})
