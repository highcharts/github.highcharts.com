/**
 * Setup of url routing, takes care of serving any result, and handling of errors.
 * @author Jon Arild Nygard
 */
'use strict'
const express = require('express')
const router = express.Router()
const config = require('./config.json')
const D = require('./download.js')
const I = require('./interpreter.js')
const U = require('./utilities.js')
const response = require('./message.json')
const build = require('../assembler/build.js').build
const tmpFolder = './tmp/'
const downloadURL = 'https://raw.githubusercontent.com/highcharts/highcharts/'

/**
 * Handle any errors that is catched in the routers.
 * Respond with a proper message to the requester.
 * @param  {Error|string} err Can either be an Error object
 * @param  {object} res Express response object.
 * @return {undefined}
 */
const handleError = (err, res) => {
  const date = U.formatDate(new Date())
  const content = [
    date,
    (typeof err === 'object') ? err.stack : err
  ]
  U.debug(true, content.join('\n'))
  res.status(response.error.status).send(response.error.body)
}

/**
 * Handle result after processing the request.
 * Respond with a proper message to the requester.
 * @param  {object} result Object containing information of the result of the request.
 * @param  {object} res Express response object.
 * @return {Promise} Returns a promise which resolves after response is sent, and temp folder is deleted.
 */
const handleResult = (result, res) => {
  return new Promise((resolve, reject) => {
    if (result.file) {
      res.sendFile(result.file, (err) => (err ? reject(err) : resolve()))
    } else {
      res.status(result.status).send(result.message)
      resolve()
    }
  })
  .then(() => (result.delete && result.file) ? U.removeFile(result.file) : '')
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
  return new Promise((resolve, reject) => {
    const filePath = repositoryURL + branch + '/js/';
    (U.exists(outputFolder + file)
      ? Promise.resolve({ status: response.ok.status })
      : D.downloadFile(filePath, file, outputFolder)
    ).then(result => {
      const localPath = __dirname + '/../' + outputFolder + file
      const r = (
        result.status === response.ok.status
        ? {
          file: U.cleanPath(localPath),
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
  return (U.exists(folder + 'js/masters/') ? Promise.resolve() : D.downloadJSFolder(folder, repositoryURL, branch))
    .then(() => {
      const localPath = __dirname + '/../' + outputFolder + (type === 'css' ? 'js/' : '') + file
      let obj = {
        file: U.cleanPath(localPath),
        status: response.ok.status
      }
      const fileExists = U.exists(outputFolder + (type === 'css' ? 'js/' : '') + file)
      const mastersExists = U.exists(folder + 'js/masters/' + file)
      if (!mastersExists) {
        obj = {
          status: response.notFound.status
        }
      } else if (!fileExists) {
        const fileOptions = I.getFileOptions(folder + 'js/masters/')
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
    })
    .catch(Promise.reject)
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
    const version = config.version // @todo Improve logic for versioning.
    const folder = tmpFolder + 'download/'
    const outputFolder = folder + 'output/'
    const LB = '\r\n' // Line break
    const imports = parts.reduce((arr, path) => {
      if (U.exists(sourceFolder + path)) {
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
    U.writeFile(folder + outputFile, content)
    build({
      base: folder,
      jsBase: sourceFolder,
      output: outputFolder,
      files: [outputFile],
      type: 'classic',
      version: version
    })
    if (compile) {
      C.compile(outputFolder + outputFile)
      outputFile = 'custom.js'
    }
    if (U.exists(outputFolder + outputFile)) {
      resolve({
        file: U.cleanPath(__dirname + '/../' + outputFolder + outputFile),
        delete: true
      })
    } else {
      reject(new Error(
        'Could not find the compiled file. Path: ' + outputFolder + outputFile
      ))
    }
  })
}

/**
 * Health check url
 */
router.get('/health', (req, res) => {
  res.sendStatus(response.ok.status)
})

/**
 * Listens to push events from a Github Webhook.
 * Validates if the payload is secure, then removes the cached source files which needs an update.
 * The removed source files will get a fresh download next time they are requested.
 */
router.post('/update', (req, res) => {
  const W = require('./webhook.js')
  const body = req.body
  const hook = W.validateWebHook(req)
  let status
  let message
  let exists = false
  let path = ''
  if (hook.valid) {
    const ref = body.ref
    const branch = ref.split('/').pop()
    if (branch) {
      path = tmpFolder + branch
      exists = U.exists(path)
      message = exists ? response.cacheDeleted.body : response.noCache.body
      status = exists ? response.cacheDeleted.status : response.noCache.status
    } else {
      status = response.invalidBranch.status
      message = response.invalidBranch.body
    }
  } else {
    message = response.insecureWebhook.body + hook.message
    status = response.insecureWebhook.status
  }

  (exists ? U.removeDirectory(path) : Promise.resolve(false))
  .then(() => ({
    status: status,
    message: message
  }))
  .then(result => handleResult(result, res))
  .catch(err => handleError(err, res))
})

/**
 * Requests to /favicon.ico
 * Always returns the icon file.
 * @todo Use express.static in stead if send file.
 */
router.get('/favicon.ico', (req, res) => {
  const pathIndex = U.cleanPath(__dirname + '/../assets/favicon.ico')
  res.sendFile(pathIndex)
})

/**
 * Requests to /
 * When the parameter parts is sent, then it is a request from the Download Builder.
 * Otherwise respond with the homepage.
 */
router.get('/', (req, res) => {
  const parts = req.query.parts
  const compile = req.query.compile === 'true';
  (
    parts
    ? serveDownloadFile(parts, compile)
    : Promise.resolve({ file: U.cleanPath(__dirname + '/../views/index.html') })
  )
  .then(result => handleResult(result, res))
  .catch(err => handleError(err, res))
})

/**
 * Everything not matching the previous routers.
 * Requests for distribution file, built with part files from github.
 */
router.get('*', (req, res) => {
  const branch = I.getBranch(req.url)
  D.urlExists(downloadURL + branch + '/assembler/build.js')
    .then(result => result ? serveBuildFile(downloadURL, req.url) : serveStaticFile(downloadURL, req.url))
    .then(result => handleResult(result, res))
    .catch(err => handleError(err, res))
})

module.exports = router
