/**
 * Utility script to help interacting with the file system on the server.
 * @author Jon Arild Nygard
 * @todo Add license
 * @todo Move debug and randomString to a seperate file.
 */
'use strict'
const path = require('path')
const fs = require('fs')
const {
  isBool,
  isDate,
  isString,
  isUndefined
} = require('./utilities.js')

const fsStat = p => {
  let result = false
  if (isString(p)) {
    try {
      result = fs.lstatSync(p)
    } catch (err) {}
  }
  return result
}

const getFilesInFolder = (folder, includeSubfolders, subfolder) => {
  let result = false
  const sub = isUndefined(subfolder) ? '' : subfolder
  if (isString(folder) && isString(sub)) {
    const fsFolderPath = path.join(folder, sub)
    const f2 = fsStat(fsFolderPath)
    const include = isBool(includeSubfolders) ? includeSubfolders : true
    if (f2 && f2.isDirectory()) {
      result = []
      fs.readdirSync(fsFolderPath).forEach((filename) => {
        const fsFilePath = path.join(fsFolderPath, filename)
        const file = fsStat(fsFilePath)
        const relativeFilePath = path.join(sub, filename).split(path.sep).join('/')
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

const exists = ph => {
  const fs = require('fs')
  let exists = true
  try {
    fs.statSync(ph)
  } catch (err) {
    exists = false
  }
  return exists
}

const getFile = ph => {
  const fs = require('fs')
  return (exists(ph) ? fs.readFileSync(ph, 'utf8') : null)
}

/**
 * Gets directory ph from a file ph
 * @param  {string} ph File ph
 * @return {string} Path to directory where the file is located
 */
const folder = ph => {
  let folderPath = '.'
  if (ph !== '') {
    folderPath = ph.substring(0, ph.lastIndexOf('/'))
  }
  return folderPath + '/'
}

/**
 * Takes a folder ph and creates all the missing folders
 * @param  {string} ph Path to directory
 * @return {undefined} Returns nothing
 */
const createDirectory = ph => {
  const fs = require('fs')
  const folders = ph.split('/').filter(item => Boolean(item))
  folders.reduce((base, name) => {
    const ph = base + name
    try {
      fs.statSync(ph)
    } catch (err) {
      fs.mkdirSync(ph)
    }
    return ph + '/'
  }, '')
}

const copyFile = (ph, output) => {
  const fs = require('fs')
  const base = __dirname + '/'
  const outFile = base + output
  createDirectory(folder(outFile))
  fs.createReadStream(base + ph).pipe(fs.createWriteStream(outFile))
}

const writeFile = (ph, content) => {
  const fs = require('fs')
  createDirectory(folder(ph))
  fs.writeFileSync(ph, content)
}

/**
 * Removes a file.
 * Creates a promise which resolves when the file is deleted.
 * Promise is rejected if the file does not exist.
 * @param  {string} ph Path to file
 * @returns {Promise} Returns a promise which resolves when the file is deleted.
 */
const removeFile = ph => new Promise((resolve, reject) => {
  const fs = require('fs')
  if (exists(ph)) {
    fs.unlink(ph, () => {
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
  const fs = require('fs')
  if (exists(ph)) {
    const files = fs.readdirSync(ph)
    const promises = files.map(file => ph + '/' + file)
            .map(itemPath => (fs.statSync(itemPath).isDirectory()) ? removeDirectory(itemPath) : removeFile(itemPath))
    Promise.all(promises)
      .then(() => {
        fs.rmdirSync(ph)
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

const randomString = (length) => {
  const possible = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const arr = Array.from({ length: length })
  return arr.map(() => {
    const index = Math.floor(Math.random() * possible.length)
    return possible.charAt(index)
  }).join('')
}

const cleanPath = ph => {
  let p = ph
  while (p.indexOf('/./') > -1) {
    p = p.replace('/./', '/')
  }
  while (p.indexOf('/../') > -1) {
    p = p.replace(/[\\\/]([^\\\/]+[\\\/]\.\.[\\\/])/g, '/')
  }
  return p
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
      date.getUTCMonth(),
      date.getUTCDate()
    ].join('-')
    const time = 'T' + [
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds()
    ].join('-')
    result = day + time
  }
  return result
}

module.exports = {
  cleanPath,
  copyFile,
  createDirectory,
  debug,
  exists,
  folder,
  formatDate,
  getFile,
  getFilesInFolder,
  randomString,
  removeDirectory,
  removeFile,
  writeFile
}
