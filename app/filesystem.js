/**
 * Utility script to help interacting with the file system on the server.
 * @author Jon Arild Nygard
 * @todo Add license
 * @todo Move debug and to a seperate file.
 */
'use strict'
const {
  dirname,
  join,
  normalize,
  sep
} = require('path')
const {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFile,
  rmdirSync,
  statSync,
  unlink,
  promises: {
    writeFile
  }
} = require('fs')
const {
  isBool,
  isDate,
  isString,
  isUndefined,
  padStart
} = require('./utilities.js')

const fsStat = p => {
  let result = false
  if (isString(p)) {
    try {
      result = lstatSync(p)
    } catch (err) {}
  }
  return result
}

const getFilesInFolder = (folder, includeSubfolders, subfolder) => {
  let result = false
  const sub = isUndefined(subfolder) ? '' : subfolder
  if (isString(folder) && isString(sub)) {
    const fsFolderPath = join(folder, sub)
    const f2 = fsStat(fsFolderPath)
    const include = isBool(includeSubfolders) ? includeSubfolders : true
    if (f2 && f2.isDirectory()) {
      result = []
      readdirSync(fsFolderPath).forEach((filename) => {
        const fsFilePath = join(fsFolderPath, filename)
        const file = fsStat(fsFilePath)
        const relativeFilePath = join(sub, filename).split(sep).join('/')
        if (file && file.isFile()) {
          result.push(relativeFilePath)
        } else if (include && file && file.isDirectory()) {
          result = result.concat(getFilesInFolder(
            folder,
            include,
            relativeFilePath
          ))
        }
      })
    }
  }
  return result
}

const exists = filePath => existsSync(filePath)

const getFilePromise = (filepath) => new Promise((resolve, reject) => {
  readFile(filepath, 'utf8', (err, data) => {
    if (err) {
      reject(err)
    } else {
      resolve(data)
    }
  })
})

/**
 * Takes a folder ph and creates all the missing folders
 * @param  {string} ph Path to directory
 * @return {undefined} Returns nothing
 */
const createDirectory = ph => {
  const pathDir = normalize(ph)
  const folders = pathDir.split(sep).filter(item => Boolean(item))
  folders.reduce((base, name) => {
    const ph = isString(base) && base.length > 0 ? join(base, name) : name
    if (!exists(ph)) {
      mkdirSync(ph)
    }
    return ph
  }, '')
}

const copyFile = (ph, output) => {
  const base = join(__dirname, '/')
  const outFile = base + output
  createDirectory(dirname(outFile))
  createReadStream(base + ph).pipe(createWriteStream(outFile))
}

async function writeFilePromise (filepath, data) {
  createDirectory(dirname(filepath))
  return writeFile(filepath, data)
}

/**
 * Removes a file.
 * Creates a promise which resolves when the file is deleted.
 * Promise is rejected if the file does not exist.
 * @param  {string} ph Path to file
 * @returns {Promise} Returns a promise which resolves when the file is deleted.
 */
const removeFile = ph => new Promise((resolve, reject) => {
  if (exists(ph)) {
    unlink(ph, () => {
      resolve(true)
    })
  } else {
    reject(new Error('File does not exist: ' + ph))
  }
})

/**
 * Removes a directory.
 * Creates a promise which resolves when the directory is deleted.
 * Promise is rejected if the file does not exist.
 * @param  {string} ph Path to file
 * @returns {Promise} Returns a promise which resolves when the file is deleted.
 */
const removeDirectory = ph => new Promise((resolve, reject) => {
  if (exists(ph)) {
    const files = readdirSync(ph)
    const promises = files.map(file => ph + '/' + file)
      .map(itemPath => (statSync(itemPath).isDirectory()) ? removeDirectory(itemPath) : removeFile(itemPath))
    Promise.all(promises)
      .then(() => {
        rmdirSync(ph)
        resolve(true)
      })
      .catch(reject)
  } else {
    reject(new Error('Directory does not exist: ' + ph))
  }
})

const debug = (d, text) => {
  if (d) {
    /* eslint-disable no-console */
    console.log(text)
    /* eslint-enable no-console */
  }
}

/**
 * formatDate - Format a date as YYYY-MM-DDTHH-MM-SS.
 * @param {Date} date A Date object to be formatted.
 * @return {bool|string} Returns false if input is not a valid date. Returns a
 *     string with date formatted as YYYY-MM-DDTHH-MM-SS.
 */
const formatDate = (date) => {
  let result = false
  if (isDate(date)) {
    const day = [
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate()
    ].map((x, i) => padStart(('' + x), (i > 0 ? 2 : 4), '0')).join('-')
    const time = 'T' + [
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds()
    ].map(x => padStart(('' + x), 2, '0')).join('-')
    result = day + time
  }
  return result
}

module.exports = {
  copyFile,
  createDirectory,
  debug,
  exists,
  formatDate,
  getFilePromise,
  getFilesInFolder,
  removeDirectory,
  removeFile,
  writeFile: writeFilePromise
}
