/**
 * Contains all handlers used in the Express router.
 * The handlers processes the HTTP request and returns a response to the client.
 * @author Jon Arild Nygard
 * @todo Add license
 */
'use strict'

// Import dependencies, sorted by path name.
const { secureToken } = require('../config.json')
const { downloadFile, downloadJSFolder, urlExists } = require('./download.js')
const {
  exists,
  getFilesInFolder,
  removeDirectory,
  writeFile
} = require('./filesystem.js')
const {
  getBranch,
  getFile,
  getFileOptions,
  getType
} = require('./interpreter.js')
const { response } = require('./message.json')
const { isString } = require('./utilities.js')
const { sha1, validateWebHook } = require('./webhook.js')
const build = require('highcharts-assembler')
const { join, normalize, resolve } = require('path')

// Constants
const PATH_TMP_DIRECTORY = './tmp/'
const URL_DOWNLOAD = 'https://raw.githubusercontent.com/highcharts/highcharts/'

/**
 * Adds error handler to async middlware functions. When an error is caught the
 * next callback is called with the error.
 * Returns the async function with an added error handler.
 *
 * @param {function} asyncFn The async function to listen for errors on.
 */
function catchAsyncErrors (asyncFn) {
  return (req, res, next) => asyncFn(req, res, next).catch(next)
}

/**
 * Creates the content for a custom file with all dependencies included.
 * Filters out dependencies that does not exist in the source folder.
 * Returns a string with the content of the file.
 *
 * @param {string} importFolder The path to the folder containing the
 * dependencies. Relative to the resulting custom file.
 * @param {string} sourceFolder The path to the folder containing the source
 * files.
 * @param {Array<string>} dependencies The dependencies of the custom file.
 */
function getCustomFileContent (importFolder, sourceFolder, dependencies) {
  const LB = '\r\n' // Line break

  // Create all import statements for the provided dependencies.
  const imports = dependencies.reduce((arr, path) => {
    if (exists(sourceFolder + path)) {
      arr.push('import \'' + importFolder + path + '\';')
    }
    return arr
  }, []).join(LB)

  // Return the file content
  return [
    '/**',
    ' * @license @product.name@ JS v@product.version@ (@product.date@)',
    ' *', ' * (c) 2009-2016 Torstein Honsi',
    ' *',
    ' * License: www.highcharts.com/license',
    ' */',
    '\'use strict\';',
    'import Highcharts from \'' + importFolder + 'parts/Globals.js\';',
    imports,
    'export default Highcharts;',
    '' // new line at end of file
  ].join(LB)
}

/**
 * Handle request to distribution files, download required source files from
 * GitHub, prepares and serves the resulting distribution file.
 * The Promise resolves when a response is sent to client.
 *
 * @param {Response} response Express response object.
 * @param {Request} request Express request object.
 */
async function handlerDefault (req, res) {
  const branch = getBranch(req.path)
  const parts = req.query.parts
  const result = parts
    // If request has a query including parts, then create a custom file.
    ? await serveDownloadFile(URL_DOWNLOAD, branch, parts)
    : await urlExists(URL_DOWNLOAD + branch + '/js/masters/highcharts.src.js')
      // If a master file exist, then create dist file using
      // highcharts-assembler.
      ? await serveBuildFile(URL_DOWNLOAD, req.url)
      // If no master file, then try to serve  a static file.
      : await serveStaticFile(URL_DOWNLOAD, req.url)

  return respondToClient(result, res, req)
}

/**
 * Handle requests to health checker.
 * The Promise resolves when a response is sent to client.
 *
 * @param {Response} response Express response object.
 * @param {Request} request Express request object.
 */
async function handlerHealth (req, res) {
  return respondToClient(response.ok, res, req)
}

/**
 * Handle requests for icon file, responds with favicon.ico.
 * The Promise resolves when a response is sent to client.
 *
 * @todo Use express.static in stead if send file.
 * @param {Response} response Express response object.
 * @param {Request} request Express request object.
 */
async function handlerIcon (req, res) {
  const result = { file: join(__dirname, '/../assets/favicon.ico') }
  return respondToClient(result, res, req)
}

/**
 * Handle requests to index file, responds with index.html.
 * The Promise resolves when a response is sent to client.
 *
 * @todo Use express.static in stead of send file.
 * @param {Response} response Express response object.
 * @param {Request} request Express request object.
 */
async function handlerIndex (req, res) {
  const result = { file: join(__dirname, '/../views/index.html') }
  return respondToClient(result, res, req)
}

/**
 * Handle requests from robots, responds with robots.txt.
 * The Promise resolves when a response is sent to client.
 *
 * @todo Use express.static in stead of send file.
 * @param {Response} response Express response object.
 * @param {Request} request Express request object.
 */
async function handlerRobots (req, res) {
  const result = { file: join(__dirname, '../assets/robots.txt') }
  return respondToClient(result, res, req)
}

/**
 * Handle requests from GitHub webhook. Validates the webhook and deletes the
 * cached source files that have been updated.
 * The Promise resolves when a response is sent to client.
 *
 * @param {Response} response Express response object.
 * @param {Request} request Express request object.
 */
async function handlerUpdate (req, res) {
  const hook = validateWebHook(req, secureToken)
  let result
  if (hook.valid) {
    const branch = req.body.ref.replace('refs/heads/', '')
    if (branch) {
      const path = join(PATH_TMP_DIRECTORY, branch)
      const doCacheExist = exists(path)
      if (doCacheExist) {
        await removeDirectory(path)
      }
      result = doCacheExist ? response.cacheDeleted : response.noCache
    } else {
      result = response.invalidBranch
    }
  } else {
    result = {
      body: response.insecureWebhook.body + hook.message,
      status: response.insecureWebhook.status
    }
  }
  return respondToClient(result, res, req)
}

/**
 * Respond to the client with a status and body, or a file transfer.
 * The Promise resolves when a response is sent to client.
 *
 * @param {object} result Object containing information of the response.
 * @param {Response} response Express response object.
 * @param {Request} request Express request object.
 */
async function respondToClient (result, response, request) {
  const { body, file, status } = result

  // Set response headers to allow all origins.
  response.header('Access-Control-Allow-Origin', '*')
  response.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept'
  )

  // Make sure connection is not lost before attemting a response.
  if (!request.connectionAborted) {
    if (file) {
      await new Promise((resolve, reject) => {
        response.sendFile(file, (err) => {
          return (err ? reject(err) : resolve())
        })
      })
    } else {
      response.status(status).send(body)
    }
  }
}

/**
 * Interprets the request URL, builds a distribution file if found, and serves
 * the result.
 * Downloads the source files for the given branch/tag/commit if they are not
 * found in the cache.
 * The Promise resolves with an object containing information on the response.
 *
 * @param {string} repositoryURL The URL to the repository containing the
 * source files.
 * @param {string} requestURL The url which the request was sent to.
 */
async function serveBuildFile (repositoryURL, requestURL) {
  const branch = getBranch(requestURL)
  const type = getType(branch, requestURL)
  const file = getFile(branch, type, requestURL)
  const folder = PATH_TMP_DIRECTORY + branch + '/'

  // Respond with not found if the interpreter can not find a filename
  if (file === false) {
    return response.notFound
  }
  if (!exists(folder + 'js/masters/')) {
    await downloadJSFolder(folder, repositoryURL, branch)
  }
  if (!exists(folder + 'js/masters/' + file)) {
    return response.notFound
  }

  const outputFolder = folder + 'output/'
  if (!exists(outputFolder + (type === 'css' ? 'js/' : '') + file)) {
    const files = getFilesInFolder(folder + 'js/masters/')
    const fileOptions = getFileOptions(files, folder + 'js')
    build({
      base: folder + 'js/masters/',
      output: outputFolder,
      files: [file],
      pretty: false,
      type: type,
      version: branch,
      fileOptions: fileOptions
    })
  }
  return {
    file: join(__dirname, '/../', outputFolder, (type === 'css' ? 'js/' : ''), file)
  }
}

/**
 * Interprets the request URL and serves a static file if found.
 * The Promise resolves with an object containing information on the response.
 *
 * @param {string} repositoryURL Url to download the file.
 * @param {string} requestURL The url which the request was sent to.
 */
async function serveStaticFile (repositoryURL, requestURL) {
  const branch = getBranch(requestURL)
  const file = getFile(branch, 'classic', requestURL)

  // Respond with not found if the interpreter can not find a filename
  if (file === false) {
    return response.notFound
  }

  const outputFolder = `${PATH_TMP_DIRECTORY}${branch}/output/`
  // Download the file if it is not already available in cache.
  if (!exists(outputFolder + file)) {
    const filePath = `${repositoryURL}${branch}/js/${file}`
    const download = await downloadFile(filePath, outputFolder + file)
    if (download.statusCode !== 200) {
      return response.notFound
    }
  }

  // Return path to file location in the cache.
  return { file: join(__dirname, '/../', outputFolder, file) }
}

/**
 * Interprets the request URL and serves a custom file with given dependencies.
 * The Promise resolves with an object containing information on the response.
 *
 * @param {string} repositoryURL Url to download the source files.
 * @param {string} branchName The name of the branch the files are located in.
 * @param {Array<string>} strParts The list of dependencies for the custom file.
 */
async function serveDownloadFile (repositoryURL, branchName, strParts) {
  const branch = isString(branchName) ? branchName : 'master'
  const parts = isString(strParts) ? strParts.split(',') : []
  const importFolder = '../js/'
  const folder = join(PATH_TMP_DIRECTORY, branch, '/')
  const sourceFolder = join(folder, 'js', '/')
  const outputFolder = join(folder, 'output/')
  /**
   * Download the source files if they are missing.
   */
  if (!exists(folder + 'js/masters/')) {
    await downloadJSFolder(folder, repositoryURL, branch)
  }
  /**
   * Create the master file if it does not exist already
   */
  const hash = sha1(secureToken, parts.join(','))
  const customMasterFile = normalize(join(folder, 'custom', hash + '.src.js'))
  if (!exists(customMasterFile)) {
    const content = getCustomFileContent(importFolder, sourceFolder, parts)
    writeFile(customMasterFile, content)
  }
  /**
   * Build the custom file from the master file, if it does not already exist
   */
  const customFile = join('custom', hash + '.src.js')
  const customFilePath = join(outputFolder, customFile)
  if (!exists(customFilePath)) {
    build({
      base: folder,
      jsBase: sourceFolder,
      output: outputFolder,
      files: [customFile],
      type: 'classic',
      version: branch + ' custom build'
    })
  }
  return { file: resolve(outputFolder, customFile) }
}

// Export handlers
module.exports = {
  catchAsyncErrors,
  handlerDefault,
  handlerHealth,
  handlerIcon,
  handlerIndex,
  handlerRobots,
  handlerUpdate
}
