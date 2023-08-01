const mocha = require('mocha')
const expect = require('chai').expect
const {
  stub
} = require('sinon')
const defaults = require('../app/middleware.js')
const describe = mocha.describe
const it = mocha.it

describe('middleware.js', () => {
  describe('exported properties', () => {
    const functions = [
      'bodyJSONParser',
      'clientErrorHandler',
      'logErrors',
      'setConnectionAborted'
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
  describe('bodyJSONParser', () => {
    const bodyJSONParser = defaults.bodyJSONParser
    const on = function (name, fn) {
      this['on' + name] = fn
    }
    it('should set property rawBody to empty string, when there is no data', () => {
      const req = { on }
      const next = stub()
      bodyJSONParser(req, {}, next)
      req.onend()
      expect(req).to.have.property('rawBody')
        .that.equals('')
      expect(req).to.not.have.property('body')
      expect(next.called).to.equal(true)
    })
    it('should set rawBody to equal data received, and body should be parsed JSON', () => {
      const req = { on }
      const next = stub()
      bodyJSONParser(req, {}, next)
      req.ondata('{ "prop": "val" }')
      req.onend()
      expect(req).to.have.property('rawBody')
        .that.equals('{ "prop": "val" }')
      expect(req).to.have.property('body')
        .that.deep.equals({ prop: 'val' })
      expect(next.called).to.equal(true)
    })
    it('should not parse invalidJSON', () => {
      const req = { on }
      const next = stub()
      bodyJSONParser(req, {}, next)
      req.ondata('abc')
      req.onend()
      expect(req).to.have.property('rawBody')
        .that.equals('abc')
      expect(req).to.not.have.property('body')
      expect(next.called).to.equal(true)
    })
  })
  describe('clientErrorHandler', () => {
    const clientErrorHandler = defaults.clientErrorHandler
    const on = function (name, fn) {
      this['on' + name] = fn
    }
    it('should send status 400 and a message to the client', () => {
      const req = { on }
      const res = {}
      res.status = stub().returns(res)
      res.send = stub().returns(res)
      const next = stub()
      clientErrorHandler(new Error('myerror'), req, res, next)
      expect(res.status.getCall(0).args[0]).to.equal(400)
      expect(res.send.getCall(0).args[0]).to.equal(
        'Something went wrong. Please contact <a href="http://www.highcharts.com/support">Highcharts support</a> if this happens repeatedly.'
      )
      expect(next.called).to.equal(true)
    })
  })
  describe('logErrors', () => {
    const logErrors = defaults.logErrors
    it('should call console.log with a message', () => {
      const log = stub(console, 'log')
      const next = stub()
      logErrors(new Error('myerror'), {}, {}, next)
      expect(log.called).to.equal(true)
      expect(next.called).to.equal(true)
      log.restore()
    })
  })
  describe('setConnectionAborted', () => {
    const setConnectionAborted = defaults.setConnectionAborted
    const on = function (name, fn) {
      this['on' + name] = fn
    }
    it('should set connectionAborted to true on close', () => {
      const req = { on, destroy: () => null }
      const next = stub()
      setConnectionAborted(req, {}, next)
      req.onclose()
      expect(req).to.have.property('connectionAborted').that.equals(true)
      expect(next.called).to.equal(true)
    })
    it('should set connectionAborted false by default', () => {
      const req = { on }
      const next = stub()
      setConnectionAborted(req, {}, next)
      expect(req).to.have.property('connectionAborted').that.equals(false)
      expect(next.called).to.equal(true)
    })
  })
})
