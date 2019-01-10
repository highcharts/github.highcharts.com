const mocha = require('mocha')
const expect = require('chai').expect
const defaults = require('../app/download.js')
const describe = mocha.describe
const it = mocha.it

describe('download.js', () => {
  describe('exported properties', () => {
    const functions = [
      'downloadFile',
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
