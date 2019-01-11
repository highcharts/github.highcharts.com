const defaults = require('../app/download.js')
const { expect } = require('chai')
const { lstatSync, rmdirSync, unlinkSync } = require('fs')
const { after, before, describe, it } = require('mocha')

describe('download.js', () => {
  describe('exported properties', () => {
    const functions = [
      'downloadFile',
      'downloadFilePromise',
      'downloadFiles',
      'downloadJSFolder',
      'getDownloadFiles',
      'httpsGetPromise',
      'urlExists'
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
    it('should error if no options is provided', () => {
      return httpsGetPromise()
        .then((x) => { throw new Error('Promise resolved unexpectedly.') })
        .catch(e => {
          expect(e.message).to.not.equal('Promise resolved unexpectedly.')
        })
    })
    it('should return a response when a url is provided', () => {
      return httpsGetPromise(downloadURL)
        .then(({ body, statusCode }) => {
          expect(statusCode).to.equal(400)
          expect(body).to.equal('400: Invalid request\n')
        })
    })
  })

  describe('downloadFile', () => {
    it('is missing tests')
  })
  describe('downloadFilePromise', () => {
    const { downloadFilePromise } = defaults
    const downloadURL = 'https://raw.githubusercontent.com/highcharts/highcharts/'
    const cleanFiles = () => {
      [
        'tmp/test/downloaded-file1.js',
        'tmp/test/downloaded-file2.js',
        'tmp/test'
      ].forEach(p => {
        try {
          const stat = lstatSync(p)
          if (stat.isFile()) {
            unlinkSync(p)
          } else if (stat.isDirectory()) {
            rmdirSync(p)
          }
        } catch (err) {}
      })
    }
    after(cleanFiles)
    before(cleanFiles)
    it('should resolve with an informational object, and a newly created file.', () => {
      return downloadFilePromise(
        downloadURL + 'master/js/masters/highcharts.src.js',
        './tmp/test/downloaded-file1.js'
      ).then(({ outputPath, statusCode, success, url }) => {
        expect(outputPath).to.equal('./tmp/test/downloaded-file1.js')
        expect(statusCode).to.equal(200)
        expect(success).to.equal(true)
        expect(url).to.equal(downloadURL + 'master/js/masters/highcharts.src.js')
        expect(lstatSync('./tmp/test/downloaded-file1.js').size).to.be.greaterThan(0)
      })
    })
    it('should only create a file if response status is 200', () => {
      return downloadFilePromise(
        downloadURL + 'master/i-do-not-exist.js',
        './tmp/test/downloaded-file2.js'
      ).then(({ outputPath, statusCode, success, url }) => {
        var exists = true
        try {
          lstatSync('./tmp/test/downloaded-file2.js')
        } catch (e) {
          exists = false
        }
        expect(statusCode).to.equal(404)
        expect(exists).to.equal(false)
      })
    })
    it('should reject when request is invalid', () => {
      return downloadFilePromise()
        .then((x) => { throw new Error('Promise resolved unexpectedly.') })
        .catch(e => {
          expect(e.message).to.not.equal('Promise resolved unexpectedly.')
        })
    })
  })
  describe('downloadFiles', () => {
    it('is missing tests')
  })
  describe('downloadJSFolder', () => {
    it('is missings tests')
  })
  describe('getDownloadFiles', () => {
    it('is missings tests')
  })
  describe('urlExists', () => {
    it('is missings tests')
  })
})
