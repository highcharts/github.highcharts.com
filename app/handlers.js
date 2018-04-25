const {
  join,
  normalize,
  resolve
} = require('path')
const {
  compileFile
} = require('./compiler.js')
const {
  secureToken
} = require('../config.json')
const {
  getBranch,
  getFile,
  getFileOptions,
  getType
} = require('./interpreter.js')
const {
  sha1,
  validateWebHook
} = require('./webhook.js')

const {
  downloadFile,
  downloadJSFolder,
  urlExists
} = require('./download.js')
const {
  isString,
  isObject
} = require('./utilities.js')
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
    res.header('Access-Control-Allow-Origin', '*')
    res.header(
      'Access-Control-Allow-Headers',
      'Origin, X-Requested-With, Content-Type, Accept'
    )
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
  const branch = getBranch(requestURL)
  const file = getFile(branch, 'classic', requestURL)
  const folder = tmpFolder + branch + '/'
  const outputFolder = folder + 'output/'
  if (file === false) {
    return {
      status: response.notFound.status
    }
  }
  return Promise.resolve()
  .then(() => {
    const filePath = repositoryURL + branch + '/js/'
    let promise
    if (exists(outputFolder + file)) {
      promise = Promise.resolve({ status: response.ok.status })
    } else {
      promise = downloadFile(filePath, file, outputFolder)
    }
    return promise
  })
  .then(request => {
    const localPath = join(__dirname, '/../', outputFolder, file)
    let result
    if (request.status === response.ok.status) {
      result = {
        file: localPath,
        status: response.ok.status,
        message: false
      }
    } else {
      result = {
        file: false,
        status: response.notFound.status,
        message: response.notFound.body
      }
    }
    return result
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
  const branch = getBranch(requestURL)
  const type = getType(branch, requestURL)
  const file = getFile(branch, type, requestURL)
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
    : downloadJSFolder(folder, repositoryURL, branch)
  ).then(() => {
    const localPath = join(__dirname, '/../', outputFolder, (type === 'css' ? 'js/' : ''), file)
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
      const fileOptions = getFileOptions(files, publicConfig.fileOptions)
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

const getCustomFileContent = (importFolder, sourceFolder, parts) => {
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
  return content
}

/**
 * Used to handle request from the Highcharts Download Builder.
 * @param  {string} jsonParts Requested part files.
 * @param  {boolean} compile Wether or not to run the Closure Compiler on result.
 * @return {Promise} Returns a promise which resolves after file is built.
 */
const serveDownloadFile = (repositoryURL, branchName, strParts, doCompile) => {
  const branch = isString(branchName) ? branchName : 'master'
  const parts = isString(strParts) ? strParts.split(',') : []
  const importFolder = '../js/'
  const folder = join(tmpFolder, branch, '/')
  const sourceFolder = join(folder, 'js', '/')
  const outputFolder = join(folder, 'output/')
  return Promise.resolve()
  .then(() => {
    /**
     * Download the source files if they are missing.
     */
    let promise
    if (!exists(folder + 'js/masters/')) {
      promise = downloadJSFolder(folder, repositoryURL, branch)
    } else {
      promise = Promise.resolve()
    }
    return promise
  })
  .then(() => {
    /**
     * Create the master file if it does not exist already
     */
    const hash = sha1(secureToken, parts.join(','))
    const customMasterFile = normalize(join(folder, 'custom', hash + '.src.js'))
    if (!exists(customMasterFile)) {
      const content = getCustomFileContent(importFolder, sourceFolder, parts)
      writeFile(customMasterFile, content)
    }
    return hash
  })
  .then((hash) => {
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
    return {
      file: resolve(outputFolder, customFile)
    }
  })
  .then((obj) => {
    /**
     * Compile the custom file if needed.
     */
    let promise = Promise.resolve()
    const result = Object.assign({}, obj)
    if (doCompile && isObject(result)) {
      const compiledFileName = result.file.replace('.src.js', '.js')
      if (!exists(compiledFileName)) {
        promise = compileFile(result.file, compiledFileName)
      }
      result.file = compiledFileName
    }
    return promise
      .then(() => result)
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
  const location = join(__dirname, '/../assets/favicon.ico')
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
  const location = join(__dirname, '../assets/robots.txt')
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
  const location = join(__dirname, '/../views/index.html')
  const result = {
    file: location
  }
  return handleResult(result, res, req)
}

/**
 * Everything not matching the previous routers.
 * Requests for distribution file, built with part files from github.
 */
const handlerDefault = (req, res) => {
  const branch = getBranch(req.path)
  // TODO Remove compile code.
  const doCompile = false
  const parts = req.query.parts
  // If a master file exist, then create dist file using highcharts-assembler.
  return urlExists(downloadURL + branch + '/js/masters/highcharts.src.js')
    .then(result => (
      parts
      ? serveDownloadFile(downloadURL, branch, parts, doCompile)
      : (
        result
        ? serveBuildFile(downloadURL, req.url)
        : serveStaticFile(downloadURL, req.url)
      )
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

module.exports = {
  catchAsyncErrors,
  handlerDefault,
  handlerHealth,
  handlerIcon,
  handlerIndex,
  handlerRobots,
  handlerUpdate
}
