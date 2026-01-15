const defaults = require('../app/download.js')
const { expect } = require('chai')
const fs = require('node:fs')
const { after, afterEach, before, describe, it } = require('mocha')

describe('download.js', () => {
  describe('exported properties', () => {
    const functions = [
      'downloadFile',
      'downloadFiles',
      'downloadSourceFolder',
      'downloadSourceFolderGit',
      'ensureGitRepo',
      'syncMaster',
      'resolveGitRef',
      'pathExistsInRepo',
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
      for (const name of functions) {
        expect(defaults).to.have.property(name)
          .that.is.a('function')
      }
    })
    it('should not have unexpected properties', () => {
      const exportedProperties = Object.keys(defaults)
      expect(exportedProperties).to.deep.equal(functions)
    })
  })

  describe('httpsGetPromise', () => {
    const { httpsGetPromise } = defaults
    it('should reject when GitHub API is disabled', function () {
      this.timeout(5000)
      return httpsGetPromise('https://raw.githubusercontent.com/highcharts/highcharts/')
        .then(() => { throw new Error('Promise resolved unexpectedly.') })
        .catch(e => {
          expect(e.message).to.equal('GitHub API requests are disabled')
        })
    })
  })

  describe('downloadFile', function () {
    this.timeout(60000)

    const { downloadFile } = defaults
    const downloadURL = 'https://raw.githubusercontent.com/highcharts/highcharts/'
    const cleanFiles = () => {
      const paths = [
        'tmp/test/downloaded-file1.js',
        'tmp/test/downloaded-file2.js',
        'tmp/test'
      ]

      for (const path of paths) {
        try {
          const stat = fs.lstatSync(path)
          if (stat.isFile()) {
            fs.unlinkSync(path)
          } else if (stat.isDirectory()) {
            fs.rmSync(path, { recursive: true, force: true })
          }
        } catch (err) {}
      }
    }
    after(cleanFiles)
    before(() => {
      fs.mkdirSync('tmp/test', { recursive: true })
    })
    it('should resolve with an informational object, and a newly created file.', () => {
      const fileUrl = `${downloadURL}master/ts/masters/highcharts.src.ts`
      return downloadFile(
        fileUrl,
        './tmp/test/downloaded-file1.js'
      ).then(({ outputPath, statusCode, success, url }) => {
        expect(outputPath).to.equal('./tmp/test/downloaded-file1.js')
        expect(statusCode).to.equal(200)
        expect(success).to.equal(true)
        expect(url).to.equal(fileUrl)
        expect(fs.lstatSync('./tmp/test/downloaded-file1.js').size).to.be.greaterThan(0)
      })
    })
    it('should only create a file if response status is 200', () => {
      const fileUrl = `${downloadURL}master/i-do-not-exist.js`
      return downloadFile(
        fileUrl,
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

  describe('Git metadata lookups', function () {
    this.timeout(60000)

    const {
      getBranchInfo,
      getCommitInfo
    } = defaults

    it('resolves branch info from git', async function () {
      const info = await getBranchInfo('master')
      if (!info?.commit?.sha) {
        this.skip()
      }
      expect(info).to.have.property('commit')
      expect(info.commit.sha).to.be.a('string')
      expect(info.commit.sha).to.match(/^[0-9a-f]{40}$/)
    })

    it('resolves commit info from git', async function () {
      const branchInfo = await getBranchInfo('master')
      if (!branchInfo?.commit?.sha) {
        this.skip()
      }
      expect(branchInfo.commit.sha).to.be.a('string')
      expect(branchInfo.commit.sha).to.match(/^[0-9a-f]{40}$/)

      const commitInfo = await getCommitInfo(branchInfo.commit.sha)
      expect(commitInfo?.sha).to.equal(branchInfo.commit.sha)
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
