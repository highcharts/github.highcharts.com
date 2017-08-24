const mocha = require('mocha')
const fs = require('fs')
const expect = require('chai').expect
const defaults = require('../app/utilities.js')
const describe = mocha.describe
const it = mocha.it
const before = mocha.before
const after = mocha.after

describe('utilities.js', () => {
  it('should have a default export', () => {
    const functions = [
      'cleanPath',
      'copyFile',
      'createDirectory',
      'debug',
      'exists',
      'folder',
      'formatDate',
      'getFile',
      'getFilesInFolder',
      'isBool',
      'isDate',
      'isString',
      'isUndefined',
      'randomString',
      'removeDirectory',
      'removeFile',
      'writeFile'
    ]
    functions.forEach((name) => {
      expect(defaults).to.have.property(name)
        .that.is.a('function')
    })
  })
  describe('formatDate', () => {
    const formatDate = defaults.formatDate
    it('should return date formatted as YYYY-MM-DDTHH-MM-SS', () => {
      const date = new Date(1503341243862)
      expect(formatDate(date)).to.equal('2017-07-21T18-47-23')
    })
    it('should return false when input is not a date', () => {
      expect(formatDate(undefined)).to.equal(false)
    })
  })
  describe('getFilesInFolder', () => {
    const getFilesInFolder = defaults.getFilesInFolder
    const cleanFiles = () => {
      [
        'tmp/test-empty',
        'tmp/test-files/file.txt',
        'tmp/test-files/subfolder/file.txt',
        'tmp/test-files/subfolder',
        'tmp/test-files'
      ].forEach(p => {
        let stat = false
        try {
          stat = fs.lstatSync(p)
        } catch (err) {}
        if (stat && stat.isFile()) {
          fs.unlinkSync(p)
        } else if (stat && stat.isDirectory()) {
          fs.rmdirSync(p)
        }
      })
    }

    // Set up preconditions and cleaning
    before(() => {
      cleanFiles()
      fs.mkdirSync('tmp/test-empty')
      fs.mkdirSync('tmp/test-files')
      fs.mkdirSync('tmp/test-files/subfolder')
      fs.writeFile('tmp/test-files/file.txt', '')
      fs.writeFile('tmp/test-files/subfolder/file.txt', '')
    })
    after(cleanFiles)

    it('should return false when path is invalid', () => {
      expect(getFilesInFolder(undefined)).to.equal(false)
    })
    it('should return false when path is not a directory', () => {
      expect(getFilesInFolder('tmp/test-not-existing')).to.equal(false)
    })
    it('should return empty array when folder is empty', () => {
      expect(getFilesInFolder('tmp/test-empty')).to.deep.equal([])
    })
    it('should return files in subfolders by default', () => {
      expect(getFilesInFolder('tmp/test-files')).to.deep.equal(['file.txt', 'subfolder/file.txt'])
    })
    it('should not include subfolders when includeSubfolders is false', () => {
      expect(getFilesInFolder('tmp/test-files', false)).to.deep.equal(['file.txt'])
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
