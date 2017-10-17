const mocha = require('mocha')
const expect = require('chai').expect
const defaults = require('../app/compiler.js')
const describe = mocha.describe
const it = mocha.it

describe('compiler.js', () => {
  describe('exported properties', () => {
    const functions = [
      'compile'
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
  describe('compile', () => {
    it('is missing tests')
  })
})
