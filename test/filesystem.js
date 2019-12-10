const mocha = require('mocha')
const fs = require('fs')
const expect = require('chai').expect
const defaults = require('../app/filesystem.js')
const describe = mocha.describe
const it = mocha.it
const before = mocha.before
const after = mocha.after

describe('filesystem.js', () => {
  it('should have a default export', () => {
    const functions = [
      'createDirectory',
      'debug',
      'exists',
      'formatDate',
      'getFilesInFolder',
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
      let date = new Date(1503341243862)
      expect(formatDate(date)).to.equal('2017-08-21T18-47-23')
      date = new Date(1499411227000)
      expect(formatDate(date)).to.equal('2017-07-07T07-07-07')
    })
    it('should return false when input is not a date', () => {
      expect(formatDate(undefined)).to.equal(false)
    })
  })
  describe('getFilesInFolder', () => {
    const getFilesInFolder = defaults.getFilesInFolder
    const throwErr = (err) => { if (err) throw err }
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
      fs.writeFile('tmp/test-files/file.txt', '', throwErr)
      fs.writeFile('tmp/test-files/subfolder/file.txt', '', throwErr)
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
})
