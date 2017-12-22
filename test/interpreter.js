const mocha = require('mocha')
const expect = require('chai').expect
const defaults = require('../app/interpreter.js')
const describe = mocha.describe
const it = mocha.it

describe('interpreter.js', () => {
  it('should have a default export', () => {
    const functions = [
      'getBranch',
      'getFile',
      'getFileOptions',
      'getType'
    ]
    functions.forEach((name) => {
      expect(defaults).to.have.property(name)
        .that.is.a('function')
    })
  })
  describe('getBranch', () => {
    const getBranch = defaults.getBranch
    it('should return "master" when url is "/modules/exporting.src.js"', () => {
      expect(getBranch('/modules/exporting.src.js')).to.equal('master')
      expect(getBranch('/highcharts.src.js')).to.equal('master')
    })
  })
  describe('getFileOptions', () => {
    const getFileOptions = defaults.getFileOptions
    const files = [
      'highcharts.src.js',
      'modules/data.src.js',
      'modules/solid-gauge.src.js'
    ]
    const options = {
      'modules': {
        'exclude': 'parts[\\\\/][^\\\\/]+\\.js$',
        'umd': false
      },
      'modules/solid-gauge.src.js': {
        'exclude': 'parts[\\\\/][^\\\\/]+\\.js$|GaugeSeries\\.js$'
      }
    }
    it('should return empty object when files is not an array', () => {
      expect(getFileOptions(undefined, options)).to.deep.equal({})
    })
    it('should return empty object when options is not an object', () => {
      expect(getFileOptions(files, undefined)).to.deep.equal({})
    })
    it('should return object containing file options', () => {
      expect(getFileOptions(files, options)).to.deep.equal({
        'modules/data.src.js': {
          exclude: /parts[\\/][^\\/]+\.js$/,
          umd: false
        },
        'modules/solid-gauge.src.js': {
          exclude: /parts[\\/][^\\/]+\.js$|GaugeSeries\.js$/,
          umd: false
        }
      })
    })
  })
})
