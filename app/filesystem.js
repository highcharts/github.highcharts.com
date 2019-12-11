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
  existsSync,
  mkdirSync,
  promises: {
    readdir,
    rmdir,
    stat,
    unlink,
    writeFile
  }
} = require('fs')
const {
  isDate,
  isString,
  padStart
} = require('./utilities.js')

/**
 * Get information about a file at a given path.
 * The Promise is resolved with the fs.Stats object for the given path, or with
 * false if the path is not existing.
 *
 * @param {string} path The path to the file.
 */
async function fsStat (path) {
  try {
    return await stat(path)
  } catch (e) {
    return false
  }
}

/**
 * Returns a list of all the filenames in a given directory. Returns false if
 * the directory is not found.
 * The Promise resolves when all the filenames are found.
 *
 * @param {string} path The path to the directory.
 * @param {boolean} [recursive=true] Wether or not to include subdirectories.
 */
async function getFileNamesInDirectory (path, recursive = true) {
  // Return false if path is not a directory
  const stat = await fsStat(path)
  if (!(stat && stat.isDirectory())) {
    return false
  }

  const files = await readdir(path)
  return files.reduce(async (filenames, filename) => {
    const subPath = join(path, filename)
    const stat = await fsStat(subPath)
    if (stat.isDirectory() && recursive) {
      filenames = (await filenames).concat(
        (await getFileNamesInDirectory(subPath, true))
          .map(x => join(filename, x).split(sep).join('/'))
      )
    } else if (stat.isFile()) {
      (await filenames).push(filename)
    }
    return filenames
  }, Promise.resolve([]))
}

const exists = filePath => existsSync(filePath)

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

async function writeFilePromise (filepath, data) {
  createDirectory(dirname(filepath))
  return writeFile(filepath, data)
}

/**
 * Remove a directory and all its content recursively.
 * The Promise resolves when the directory is deleted. The Promise is rejected
 * if the directory is not found.
 * @param  {string} path The path to the directory.
 */
async function removeDirectory (path) {
  if (exists(path)) {
    // Delete the contents of the directory
    const files = await readdir(path)
    const deleteContents = files.map(async file => {
      const itemPath = join(path, file)
      return (await fsStat(itemPath).isDirectory())
        ? removeDirectory(itemPath)
        : unlink(itemPath)
    })
    await Promise.all(deleteContents)

    // Finally remove the directory itself
    await rmdir(path)
  } else {
    throw new Error(`Directory does not exist: ${path}`)
  }
}

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
  createDirectory,
  debug,
  exists,
  formatDate,
  getFileNamesInDirectory,
  removeDirectory,
  writeFile: writeFilePromise
}
