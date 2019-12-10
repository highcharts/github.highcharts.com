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
const { sha1, validateWebHook } = require('./webhook.js')
const build = require('highcharts-assembler')
const { join } = require('path')

// Constants
const PATH_TMP_DIRECTORY = join(__dirname, '../tmp')
const URL_DOWNLOAD = 'https://raw.githubusercontent.com/highcharts/highcharts/'

/**
 * Adds error handler to async middleware functions. When an error is caught the
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
 * Returns a string with the content of the file.
 *
 * @param {Array<string>} dependencies The dependencies of the custom file.
 */
function getCustomFileContent (dependencies) {
  const LB = '\r\n' // Line break
  const importFolder = '../js/'

  // Create all import statements for the provided dependencies.
  const imports = dependencies
    .map(path => 'import \'' + importFolder + path + '\';')
    .join(LB)

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

  // Serve a file depending on the request URL.
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

  // Check if the webhook is valid
  if (hook.valid) {
    const branch = req.body.ref.replace('refs/heads/', '')

    // Check if branch name is provided
    if (branch) {
      const pathCacheDirectory = join(PATH_TMP_DIRECTORY, branch)
      const doCacheExist = exists(pathCacheDirectory)

      // Remove the cache if it exists
      if (doCacheExist) {
        await removeDirectory(pathCacheDirectory)
      }

      // Respond with information of if the cache was deleted
      result = doCacheExist ? response.cacheDeleted : response.noCache
    } else {
      // Respond with information of invalid branch
      result = response.invalidBranch
    }
  } else {
    // Respond with information of insecure webhook
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

  // Respond with not found if the interpreter can not find a filename.
  if (file === false) {
    return response.notFound
  }

  const pathCacheDirectory = join(PATH_TMP_DIRECTORY, branch)
  const pathMastersDirectory = join(pathCacheDirectory, 'js', 'masters')
  // Download the source files if they are not found in the cache.
  if (!exists(pathMastersDirectory)) {
    await downloadJSFolder(pathCacheDirectory, repositoryURL, branch)
  }

  // Respond with not found if the master file is not found in the cache.
  if (!exists(join(pathMastersDirectory, file))) {
    return response.notFound
  }

  const pathOutputFolder = join(pathCacheDirectory, 'output')
  const pathOutputFile = join(
    pathOutputFolder, (type === 'css' ? 'js' : ''), file
  )
  // Build the distribution file if it is not found in cache.
  if (!exists(pathOutputFile)) {
    const files = getFilesInFolder(pathMastersDirectory)
    const fileOptions = getFileOptions(files, join(pathCacheDirectory, 'js'))
    build({
      // TODO: Remove trailing slash when assembler has fixed path concatenation
      base: pathMastersDirectory + '/',
      output: pathOutputFolder,
      files: [file],
      pretty: false,
      type: type,
      version: branch,
      fileOptions: fileOptions
    })
  }

  // Return path to file location in the cache.
  return { file: pathOutputFile }
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

  // Respond with not found if the interpreter can not find a filename.
  if (file === false) {
    return response.notFound
  }

  const pathFile = join(PATH_TMP_DIRECTORY, branch, 'output', file)
  // Download the file if it is not already available in cache.
  if (!exists(pathFile)) {
    const urlFile = `${repositoryURL}${branch}/js/${file}`
    const download = await downloadFile(urlFile, pathFile)
    if (download.statusCode !== 200) {
      return response.notFound
    }
  }

  // Return path to file location in the cache.
  return { file: pathFile }
}

/**
 * Interprets the request URL and serves a custom file with given dependencies.
 * The Promise resolves with an object containing information on the response.
 *
 * @param {string} repositoryURL Url to download the source files.
 * @param {string} [branch] The name of the branch the files are located in.
 * @param {string} [strParts] The list of dependencies for the custom file.
 */
async function serveDownloadFile (repositoryURL, branch = 'master', strParts = '') {
  const pathCacheDirectory = join(PATH_TMP_DIRECTORY, branch)

  // Download the source files if not found in the cache.
  if (!exists(join(pathCacheDirectory, 'js/masters'))) {
    await downloadJSFolder(pathCacheDirectory, repositoryURL, branch)
  }

  // Filter out filenames that is not existing in the source directory.
  const pathJSFolder = join(pathCacheDirectory, 'js')
  const parts = strParts.split(',')
    .filter(filename => exists(join(pathJSFolder, filename)))

  // Create a unique name for the file based on the content.
  const hash = sha1(secureToken, parts.join(','))
  const filename = join('custom', `${hash}.src.js`)

  // Create the master file if it not found in the cache.
  const pathMasterFile = join(pathCacheDirectory, filename)
  if (!exists(pathMasterFile)) {
    const content = getCustomFileContent(parts)
    await writeFile(pathMasterFile, content)
  }

  const pathOutputFolder = join(pathCacheDirectory, 'output')
  const pathFile = join(pathOutputFolder, filename)
  // Build the custom file from the master file if it is not found in the cache.
  if (!exists(pathFile)) {
    build({
      base: pathCacheDirectory + '/',
      jsBase: pathJSFolder + '/',
      output: pathOutputFolder,
      files: [filename],
      type: 'classic',
      version: branch + ' custom build'
    })
  }

  // Return path to file location in the cache.
  return { file: pathFile }
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
