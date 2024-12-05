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

    it('should return "main" when first section is either a file, folder or type', async () => {
      [
        '/modules/exporting.src.js',
        '/highcharts.src.js',
        '/css/highcharts.css',
        '/js/highcharts.src.js',
        '/gantt/highcharts.src.js'
      ].forEach(async (branch) => {
        expect((await getBranch(branch))).to.equal('main')
      })
    })
    // it('should support multiple level branch names for bugfix and feature', () => {
    //   expect(getBranch('/bugfix/modules/exporting.src.js'))
    //     .to.equal('bugfix')
    //   expect(getBranch('/bugfix/issue-name/modules/exporting.src.js'))
    //     .to.equal('bugfix/issue-name')
    //   expect(getBranch('/feature/modules/exporting.src.js'))
    //     .to.equal('feature')
    //   expect(getBranch('/feature/feature-name/modules/exporting.src.js'))
    //     .to.equal('feature/feature-name')
    // })

    it('should support custom builds', async () => {
      expect(await getBranch('/6.0.7'))
        .to.equal('6.0.7')
    })
  })

  describe('getType', () => {
    const getType = defaults.getType
    it('should support multiple level branch names for bugfix and feature', () => {
      expect(getType('bugfix', '/bugfix/modules/exporting.src.js'))
        .to.equal('classic')
      expect(getType('bugfix', '/bugfix/js/modules/exporting.src.js'))
        .to.equal('css')
      expect(getType('bugfix/issue-name', '/bugfix/issue-name/modules/exporting.src.js'))
        .to.equal('classic')
      expect(getType('bugfix/issue-name', '/bugfix/issue-name/js/modules/exporting.src.js'))
        .to.equal('css')
    })

    it('should support custom builds', () => {
      expect(getType('6.0.7', '/6.0.7'))
        .to.equal('classic')
    })
  })

  describe('getFile', () => {
    const getFile = defaults.getFile

    it('should support product folders', () => {
      expect(getFile('main', 'classic', '/gantt/highcharts.src.js'))
        .to.equal('highcharts.src.js')
    })

    it('should support multiple level branch names for bugfix and feature', () => {
      expect(getFile('bugfix', 'classic', '/modules/exporting.src.js'))
        .to.equal('modules/exporting.src.js')
      expect(getFile('bugfix', 'css', '/bugfix/js/modules/exporting.src.js'))
        .to.equal('modules/exporting.src.js')
      expect(getFile('bugfix/issue-name', 'classic', '/bugfix/issue-name/modules/exporting.src.js'))
        .to.equal('modules/exporting.src.js')
      expect(getFile('bugfix/issue-name', 'css', '/bugfix/issue-name/js/modules/exporting.src.js'))
        .to.equal('modules/exporting.src.js')
    })

    it('should support custom builds', () => {
      expect(getFile('6.0.7', 'classic', '/6.0.7'))
        .to.equal(false)
    })
  })

  // describe('getFileOptions', () => {
  //   const getFileOptions = defaults.getFileOptions
  //   const files = [
  //     'highcharts.src.js',
  //     'modules/data.src.js',
  //     'modules/solid-gauge.src.js'
  //   ]
  //   const options = {
  //     'modules': {
  //       'exclude': 'parts[\\\\/][^\\\\/]+\\.js$',
  //       'umd': false
  //     },
  //     'modules/solid-gauge.src.js': {
  //       'exclude': 'parts[\\\\/][^\\\\/]+\\.js$|GaugeSeries\\.js$'
  //     }
  //   }
  //   it('should return empty object when files is not an array', () => {
  //     expect(getFileOptions(undefined, options)).to.deep.equal({})
  //   })
  //   it('should return empty object when options is not an object', () => {
  //     expect(getFileOptions(files, undefined)).to.deep.equal({})
  //   })
  //   it('should return object containing file options', () => {
  //     expect(getFileOptions(files, options)).to.deep.equal({
  //       'modules/data.src.js': {
  //         exclude: /parts[\\/][^\\/]+\.js$/,
  //         umd: false
  //       },
  //       'modules/solid-gauge.src.js': {
  //         exclude: /parts[\\/][^\\/]+\.js$|GaugeSeries\.js$/,
  //         umd: false
  //       }
  //     })
  //   })
  // })
})
