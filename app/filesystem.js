/**
 * Utility script to help interacting with the file system on the server.
 * @author Jon Arild Nygard
 * @todo Add license
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
  promises: {
    mkdir,
    readdir,
    rmdir,
    stat,
    unlink,
    writeFile
  }
} = require('fs')

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
 * Recursively creates all missing directiories in a given path.
 * The Promise resolves when the directories are created.
 *
 * @param  {string} path Path to directory.
 */
async function createDirectory (path) {
  const folders = normalize(path).split(sep)
  await folders.reduce(async (base, name) => {
    const subPath = join(await base, name)
    if (!existsSync(subPath)) {
      await mkdir(subPath)
    }
    return subPath
  })
}

async function writeFilePromise (filepath, data) {
  await createDirectory(dirname(filepath))
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

module.exports = {
  createDirectory,
  exists,
  getFileNamesInDirectory,
  removeDirectory,
  writeFile: writeFilePromise
}
