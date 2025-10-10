const defaults = require('../app/download.js')
const { expect } = require('chai')
const fs = require('fs')
const { after, afterEach, before, describe, it } = require('mocha')
const sinon = require('sinon')

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
      '__setGitHubRequest',
      '__clearGitHubCache'
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
      return httpsGetPromise(downloadURL)
        .then(({ body, statusCode }) => {
          expect(statusCode).to.equal(400)
          expect(body).to.equal('400: Invalid request')
        })
    })
  })

  describe('downloadFile', () => {
    const { downloadFile } = defaults
    const downloadURL = 'https://raw.githubusercontent.com/highcharts/highcharts/'
    const cleanFiles = () => {
      [
        'tmp/test/downloaded-file1.js',
        'tmp/test/downloaded-file2.js',
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
      fs.mkdirSync('tmp/test', { recursive: true })
    })
    it('should resolve with an informational object, and a newly created file.', () => {
      return downloadFile(
        downloadURL + 'master/ts/masters/highcharts.src.ts',
        './tmp/test/downloaded-file1.js'
      ).then(({ outputPath, statusCode, success, url }) => {
        expect(outputPath).to.equal('./tmp/test/downloaded-file1.js')
        expect(statusCode).to.equal(200)
        expect(success).to.equal(true)
        expect(url).to.equal(downloadURL + 'master/ts/masters/highcharts.src.ts')
        expect(fs.lstatSync('./tmp/test/downloaded-file1.js').size).to.be.greaterThan(0)
      })
    })
    it('should only create a file if response status is 200', () => {
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
    it('is missings tests')
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
    })

    it('reuses the same request for parallel branch lookups', async () => {
      const stub = sinon.stub().resolves({
        statusCode: 200,
        body: JSON.stringify({ commit: { sha: 'abc123' } })
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
        body: JSON.stringify({ sha: 'deadbeef' })
      })

      __clearGitHubCache()
      __setGitHubRequest(stub)

      const first = await getCommitInfo('deadbeef')
      const second = await getCommitInfo('deadbeef')

      expect(stub.callCount).to.equal(1)
      expect(first?.sha).to.equal('deadbeef')
      expect(second?.sha).to.equal('deadbeef')
    })
  })
})
