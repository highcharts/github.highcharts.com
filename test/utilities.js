const mocha = require('mocha')
const expect = require('chai').expect
const defaults = require('../app/utilities.js')
const describe = mocha.describe
const it = mocha.it

describe('utilities.js', () => {
  describe('exported properties', () => {
    const functions = [
      'isArray',
      'isBool',
      'isDate',
      'isNull',
      'isObject',
      'isString',
      'isUndefined',
      'padStart'
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
  describe('isArray', () => {
    const isArray = defaults.isArray
    it('should return true when array', () => {
      expect(isArray([])).to.equal(true)
    })
    it('should return false when boolean', () => {
      expect(isArray(false)).to.equal(false)
    })
    it('should return false when undefined', () => {
      expect(isArray(undefined)).to.equal(false)
    })
    it('should return false when null', () => {
      expect(isArray(null)).to.equal(false)
    })
    it('should return false when object', () => {
      expect(isArray({})).to.equal(false)
    })
    it('should return false when number', () => {
      expect(isArray(1)).to.equal(false)
    })
    it('should return false when string', () => {
      expect(isArray('')).to.equal(false)
    })
    it('should return false when function', () => {
      expect(isArray(function () {})).to.equal(false)
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
  describe('isNull', () => {
    const isNull = defaults.isNull
    it('should return true when null', () => {
      expect(isNull(null)).to.equal(true)
    })
    it('should return false when object', () => {
      expect(isNull({})).to.equal(false)
    })
    it('should return false when boolean', () => {
      expect(isNull(false)).to.equal(false)
    })
    it('should return false when undefined', () => {
      expect(isNull(undefined)).to.equal(false)
    })
    it('should return false when array', () => {
      expect(isNull([])).to.equal(false)
    })
    it('should return false when number', () => {
      expect(isNull(1)).to.equal(false)
    })
    it('should return false when string', () => {
      expect(isNull('')).to.equal(false)
    })
    it('should return false when function', () => {
      expect(isNull(function () {})).to.equal(false)
    })
  })
  describe('isObject', () => {
    const isObject = defaults.isObject
    it('should return true when object', () => {
      expect(isObject({})).to.equal(true)
    })
    it('should return false when boolean', () => {
      expect(isObject(false)).to.equal(false)
    })
    it('should return false when undefined', () => {
      expect(isObject(undefined)).to.equal(false)
    })
    it('should return false when null', () => {
      expect(isObject(null)).to.equal(false)
    })
    it('should return false when array', () => {
      expect(isObject([])).to.equal(false)
    })
    it('should return false when number', () => {
      expect(isObject(1)).to.equal(false)
    })
    it('should return false when string', () => {
      expect(isObject('')).to.equal(false)
    })
    it('should return false when function', () => {
      expect(isObject(function () {})).to.equal(false)
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
  describe('padStart', () => {
    const padStart = defaults.padStart
    it('should return false when str is not a string', () => {
      expect(padStart(undefined, 2, '0')).to.equal(false)
    })
    it('should return the string as it is when length is not a number', () => {
      expect(padStart('string', undefined, '0')).to.equal('string')
    })
    it('should return the string padded with " " when char is not a string', () => {
      expect(padStart('string', 10, undefined)).to.equal('    string')
    })
    it('should return the string as it is when length is less than string', () => {
      expect(padStart('string', -1, 'x')).to.equal('string')
    })
    it('should return the string padded with char and correct length', () => {
      expect(padStart('string', 10, 'x')).to.equal('xxxxstring')
      expect(padStart('string', 10, 'xo')).to.equal('xoxostring')
    })
  })
})
