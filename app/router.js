/**
 * Setup of url routing, takes care of serving any result, and handling of errors.
 * @author Jon Arild Nygard
 */
'use strict'
const express = require('express')
const path = require('path')
const router = express.Router()
const {
  secureToken,
  version
} = require('../config.json')
const {
  validateWebHook
} = require('./webhook.js')

const D = require('./download.js')
const I = require('./interpreter.js')
const {
  exists,
  getFilesInFolder,
  removeDirectory,
  removeFile,
  writeFile
} = require('./filesystem.js')
const publicConfig = require('./message.json')
const response = publicConfig.response
const build = require('highcharts-assembler')
const tmpFolder = './tmp/'
const downloadURL = 'https://raw.githubusercontent.com/highcharts/highcharts/'

/**
 * catchAsyncErrors - Catch errors in async requests and pass them to the next
 * middleware to handle the error.
 *
 * @param {function} asyncFn The async function to listen for errors on.
 * @return {Promise} returns a promise function with a rejection handler.
 */
const catchAsyncErrors = (asyncFn) => {
  return (req, res, next) => asyncFn(req, res, next).catch(err => next(err))
}

/**
 * Handle result after processing the request.
 * Respond with a proper message to the requester.
 * @param  {object} result Object containing information of the result of the request.
 * @param  {object} res Express response object.
 * @return {Promise} Returns a promise which resolves after response is sent, and temp folder is deleted.
 */
const handleResult = (result, res, req) => {
  return new Promise((resolve, reject) => {
    if (result.file) {
      if (!req.connectionAborted) {
        res.sendFile(result.file, (err) => (err ? reject(err) : resolve()))
      }
    } else {
      if (!req.connectionAborted) {
        res.status(result.status).send(result.message)
      }
      resolve()
    }
  })
  .then(() => (result.delete && result.file) ? removeFile(result.file) : '')
}

/**
 * Used to handle a request for a static file.
 * @param  {string} repositoryURL Url to download the file.
 * @param  {string} requestURL The url which the request was sent to.
 * @return {Promise} Returns a promise which resolves after file is downloaded.
 */
const serveStaticFile = (repositoryURL, requestURL) => {
  const branch = I.getBranch(requestURL)
  const file = I.getFile(branch, 'classic', requestURL)
  const folder = tmpFolder + branch + '/'
  const outputFolder = folder + 'output/'
  if (file === false) {
    return {
      status: response.notFound.status
    }
  }
  return new Promise((resolve, reject) => {
    const filePath = repositoryURL + branch + '/js/';
    (exists(outputFolder + file)
      ? Promise.resolve({ status: response.ok.status })
      : D.downloadFile(filePath, file, outputFolder)
    ).then(result => {
      const localPath = path.join(__dirname, '/../', outputFolder, file)
      const r = (
        result.status === response.ok.status
        ? {
          file: localPath,
          status: response.ok.status,
          message: false
        }
        : {
          file: false,
          status: response.notFound.status,
          message: response.notFound.body
        }
      )
      resolve(r)
    })
    .catch(reject)
  })
}

/**
 * Used to handle requests for non-static files.
 * Downloads the source files for the given branch/tag/commit if they are not already in the filesystem.
 * Builds the requested file, if the file already exists it skips the build and serves the existing one.
 * @param  {string} repositoryURL Url to download the file.
 * @param  {string} requestURL The url which the request was sent to.
 * @return {Promise} Returns a promise which resolves after file is built.
 */
const serveBuildFile = (repositoryURL, requestURL) => {
  const branch = I.getBranch(requestURL)
  const type = I.getType(branch, requestURL)
  const file = I.getFile(branch, type, requestURL)
  const folder = tmpFolder + branch + '/'
  const outputFolder = folder + 'output/'
  if (file === false) {
    return {
      status: response.notFound.status
    }
  }
  return (
    exists(folder + 'js/masters/')
    ? Promise.resolve()
    : D.downloadJSFolder(folder, repositoryURL, branch)
  ).then(() => {
    const localPath = path.join(__dirname, '/../', outputFolder, (type === 'css' ? 'js/' : ''), file)
    let obj = {
      file: localPath,
      status: response.ok.status
    }
    const fileExists = exists(outputFolder + (type === 'css' ? 'js/' : '') + file)
    const mastersExists = exists(folder + 'js/masters/' + file)
    if (!mastersExists) {
      obj = {
        status: response.notFound.status
      }
    } else if (!fileExists) {
      const files = getFilesInFolder(folder + 'js/masters/')
      const fileOptions = I.getFileOptions(files, publicConfig.fileOptions)
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
    return obj
  }).catch(err => Promise.reject(err))
}

/**
 * Used to handle request from the Highcharts Download Builder.
 * @param  {string} jsonParts Requested part files.
 * @param  {boolean} compile Wether or not to run the Closure Compiler on result.
 * @return {Promise} Returns a promise which resolves after file is built.
 */
const serveDownloadFile = (jsonParts, compile) => {
  return new Promise((resolve, reject) => {
    const C = require('./compiler.js')
    const parts = JSON.parse(jsonParts)
    const importFolder = '../../source/download/js/'
    const sourceFolder = './source/download/js/'
    const folder = tmpFolder + 'download/'
    const outputFolder = folder + 'output/'
    const LB = '\r\n' // Line break
    const imports = parts.reduce((arr, path) => {
      if (exists(sourceFolder + path)) {
        arr.push('import \'' + importFolder + path + '\';')
      }
      return arr
    }, []).join(LB)
    const content = [
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
    let outputFile = 'custom.src.js'
    let result
    writeFile(folder + outputFile, content)
    build({
      base: folder,
      jsBase: sourceFolder,
      output: outputFolder,
      files: [outputFile],
      type: 'classic',
      version: version
    })
    if (compile) {
      if (exists(outputFolder + outputFile)) {
        C.compile(outputFolder + outputFile)
        outputFile = 'custom.js'
      } else {
        result = {
          message: response.missingFile.body + outputFolder + outputFile,
          status: response.missingFile.status
        }
        resolve(result)
      }
    }
    if (exists(outputFolder + outputFile)) {
      result = {
        file: path.join(__dirname, '/../', outputFolder, outputFile),
        message: false,
        delete: true
      }
    } else {
      result = {
        message: response.missingFile.body + outputFolder + outputFile,
        status: response.missingFile.status
      }
    }
    resolve(result)
  })
}

/**
 * Health check url
 */
const handlerHealth = (req, res) => {
  const result = {
    status: response.ok.status,
    message: response.ok.body
  }
  return handleResult(result, res, req)
}

/**
 * Requests to /favicon.ico
 * Always returns the icon file.
 * @todo Use express.static in stead if send file.
 */
const handlerIcon = (req, res) => {
  const location = path.join(__dirname, '/../assets/favicon.ico')
  const result = {
    file: location
  }
  return handleResult(result, res, req)
}

/**
 * Requests to /robots.txt
 * Always returns the robots file.
 * TODO Use express.static in stead if send file.
 */
const handlerRobots = (req, res) => {
  const location = path.join(__dirname, '../assets/robots.txt')
  const result = {
    file: location
  }
  return handleResult(result, res, req)
}

/**
 * Requests to /
 * When the parameter parts is sent, then it is a request from the Download Builder.
 * Otherwise respond with the homepage.
 */
const handlerIndex = (req, res) => {
  const parts = req.query.parts
  const compile = req.query.compile === 'true'
  const promise = (
    parts
    ? serveDownloadFile(parts, compile)
    : Promise.resolve({ file: path.join(__dirname, '/../views/index.html') })
  )

  return promise
  .then(result => handleResult(result, res, req))
}

/**
 * Everything not matching the previous routers.
 * Requests for distribution file, built with part files from github.
 */
const handlerDefault = (req, res) => {
  const branch = I.getBranch(req.url)
  // If a master file exist, then create dist file using highcharts-assembler.
  return D.urlExists(downloadURL + branch + '/js/masters/highcharts.src.js')
    .then(result => (
      result
      ? serveBuildFile(downloadURL, req.url)
      : serveStaticFile(downloadURL, req.url)
    ))
    .then(result => handleResult(result, res, req))
}

/**
 * Listens to push events from a Github Webhook.
 * Validates if the payload is secure, then removes the cached source files which needs an update.
 * The removed source files will get a fresh download next time they are requested.
 */
const handlerUpdate = (req, res) => {
  const body = req.body
  const hook = validateWebHook(req, secureToken)
  let status
  let message
  let ex = false
  let path = ''
  if (hook.valid) {
    const ref = body.ref
    const branch = ref.split('/').pop()
    if (branch) {
      path = tmpFolder + branch
      ex = exists(path)
      message = ex ? response.cacheDeleted.body : response.noCache.body
      status = ex ? response.cacheDeleted.status : response.noCache.status
    } else {
      status = response.invalidBranch.status
      message = response.invalidBranch.body
    }
  } else {
    message = response.insecureWebhook.body + hook.message
    status = response.insecureWebhook.status
  }

  return (ex ? removeDirectory(path) : Promise.resolve(false))
  .then(() => ({
    status: status,
    message: message
  }))
  .then(result => handleResult(result, res, req))
}

router.get('/health', catchAsyncErrors(handlerHealth))
router.post('/update', catchAsyncErrors(handlerUpdate))
router.get('/favicon.ico', catchAsyncErrors(handlerIcon))
router.get('/robots.txt', catchAsyncErrors(handlerRobots))
router.get('/', catchAsyncErrors(handlerIndex))
router.get('*', catchAsyncErrors(handlerDefault))

module.exports = router
