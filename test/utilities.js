const mocha = require('mocha')
const expect = require('chai').expect
const defaults = require('../app/utilities.js')
const describe = mocha.describe
const it = mocha.it

describe('utilities.js', () => {
  it('should have a default export', () => {
    const functions = [
      'isArray',
      'isBool',
      'isDate',
      'isString',
      'isUndefined'
    ]
    functions.forEach((name) => {
      expect(defaults).to.have.property(name)
        .that.is.a('function')
    })
  })
  describe('isBool', () => {
    const isBool = defaults.isBool
    it('should return true when boolean', () => {
      expect(isBool(false)).to.equal(true)
    })
    it('should return false when undefined', () => {
      expect(isBool(undefined)).to.equal(false)
    })
    it('should return false when null', () => {
      expect(isBool(null)).to.equal(false)
    })
    it('should return false when object', () => {
      expect(isBool({})).to.equal(false)
    })
    it('should return false when array', () => {
      expect(isBool([])).to.equal(false)
    })
    it('should return false when number', () => {
      expect(isBool(1)).to.equal(false)
    })
    it('should return false when string', () => {
      expect(isBool('')).to.equal(false)
    })
    it('should return false when function', () => {
      expect(isBool(function () {})).to.equal(false)
    })
  })
  describe('isDate', () => {
    const isDate = defaults.isDate
    it('should return true when Date', () => {
      expect(isDate(new Date())).to.equal(true)
    })
    it('should return false when invalid Date', () => {
      expect(isDate(new Date('a'))).to.equal(false)
    })
    it('should return false when undefined', () => {
      expect(isDate(undefined)).to.equal(false)
    })
    it('should return false when null', () => {
      expect(isDate(null)).to.equal(false)
    })
    it('should return false when object', () => {
      expect(isDate({})).to.equal(false)
    })
    it('should return false when array', () => {
      expect(isDate([])).to.equal(false)
    })
    it('should return false when boolean', () => {
      expect(isDate(true)).to.equal(false)
    })
    it('should return false when number', () => {
      expect(isDate(1)).to.equal(false)
    })
    it('should return false when string', () => {
      expect(isDate('')).to.equal(false)
    })
    it('should return false when function', () => {
      expect(isDate(function () {})).to.equal(false)
    })
  })
  describe('isString', () => {
    const isString = defaults.isString
    it('should return true when string', () => {
      expect(isString('')).to.equal(true)
    })
    it('should return false when boolean', () => {
      expect(isString(true)).to.equal(false)
    })
    it('should return false when undefined', () => {
      expect(isString(undefined)).to.equal(false)
    })
    it('should return false when null', () => {
      expect(isString(null)).to.equal(false)
    })
    it('should return false when object', () => {
      expect(isString({})).to.equal(false)
    })
    it('should return false when array', () => {
      expect(isString([])).to.equal(false)
    })
    it('should return false when number', () => {
      expect(isString(1)).to.equal(false)
    })
    it('should return false when function', () => {
      expect(isString(function () {})).to.equal(false)
    })
  })
  describe('isUndefined', () => {
    const isUndefined = defaults.isUndefined
    it('should return true when undefined', () => {
      expect(isUndefined(undefined)).to.equal(true)
    })
    it('should return false when string', () => {
      expect(isUndefined('')).to.equal(false)
    })
    it('should return false when boolean', () => {
      expect(isUndefined(true)).to.equal(false)
    })
    it('should return false when null', () => {
      expect(isUndefined(null)).to.equal(false)
    })
    it('should return false when object', () => {
      expect(isUndefined({})).to.equal(false)
    })
    it('should return false when array', () => {
      expect(isUndefined([])).to.equal(false)
    })
    it('should return false when number', () => {
      expect(isUndefined(1)).to.equal(false)
    })
    it('should return false when function', () => {
      expect(isUndefined(function () {})).to.equal(false)
    })
  })
})
