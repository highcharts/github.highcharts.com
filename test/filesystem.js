const mocha = require('mocha')
const fs = require('fs')
const expect = require('chai').expect
const defaults = require('../app/filesystem.js')
const { join } = require('path')
const describe = mocha.describe
const it = mocha.it
const before = mocha.before
const after = mocha.after

const throwErr = (err) => { if (err) throw err }
const cleanFiles = () => {
  [
    'tmp/test-empty',
    'tmp/test-files/file.txt',
    'tmp/test-files/subfolder/file.txt',
    'tmp/test-files/subfolder',
    'tmp/test-files',
    'tmp/fakebranchhash/info.json',
    'tmp/fakebranchhash',
    'tmp'
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

describe('filesystem.js', () => {
  it('should have a default export', () => {
    const functions = [
      'createDirectory',
      'exists',
      'getFileNamesInDirectory',
      'removeDirectory',
      'writeFile'
    ]
    functions.forEach((name) => {
      expect(defaults).to.have.property(name)
        .that.is.a('function')
    })
  })

  describe('getFileNamesInDirectory', () => {
    const getFileNamesInDirectory = defaults.getFileNamesInDirectory

    // Set up preconditions and cleaning
    before(() => {
      cleanFiles()
      fs.mkdirSync('tmp/test-empty', { recursive: true })
      fs.mkdirSync('tmp/test-files/subfolder', { recursive: true })
      fs.writeFile('tmp/test-files/file.txt', '', throwErr)
      fs.writeFile('tmp/test-files/subfolder/file.txt', '', throwErr)
    })
    after(cleanFiles)

    it('should return false when path is invalid', async () => {
      expect(await getFileNamesInDirectory(undefined)).to.equal(false)
    })
    it('should return false when path is not a directory', async () => {
      expect(await getFileNamesInDirectory('tmp/test-not-existing')).to.equal(false)
    })
    it('should return empty array when folder is empty', async () => {
      expect(await getFileNamesInDirectory('tmp/test-empty')).to.deep.equal([])
    })
    it('should return files in subfolders by default', async () => {
      expect(await getFileNamesInDirectory('tmp/test-files')).to.deep.equal(['file.txt', 'subfolder/file.txt'])
    })
    it('should not include subfolders when includeSubfolders is false', async () => {
      expect(await getFileNamesInDirectory('tmp/test-files', false)).to.deep.equal(['file.txt'])
    })
  })
})

describe('tmp folder cleanup function', () => {
  const { cleanUp } = require('../app/filesystem.js')

  before(async () => {
    // Make a fake branch that should be deleted
    const fakeBranchPath = join(__dirname, '../tmp/fakebranchhash')
    await fs.promises.mkdir(fakeBranchPath, { recursive: true })
  })

  after(cleanFiles)

  it('Should delete the branch', async () => {
    await cleanUp(true)

    const branches = await fs.promises.readdir(join(__dirname, '../tmp/'))

    expect(branches).to.be.an('array').that.does.not.includes('fakebranchhash')
  })
})
