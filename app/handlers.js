// @ts-check
/**
 * Contains all handlers used in the Express router.
 * The handlers processes the HTTP request and returns a response to the client.
 * @author Jon Arild Nygard
 * @todo Add license
 */
'use strict'

// Import dependencies, sorted by path name.
const { secureToken, repo } = require('../config.json')
const { downloadFile, downloadSourceFolder, downloadSourceFolderGit, urlExists, getBranchInfo, getCommitInfo } = require('./download.js')
const { compileTypeScriptProject, getGlobalsLocation, log, updateBranchAccess } = require('./utilities')

const {
  exists,
  getFileNamesInDirectory,
  writeFile,
  cleanUp
  /* removeDirectory */
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
const URL_DOWNLOAD = `https://raw.githubusercontent.com/${repo}/`

/**
 * Tries to look for a remote tsconfig file if the branch/ref is of newer date typically 2019+.
 * If one exists it will return true
 * @param {String} repoURL to repository on GitHub
 * @param {String} branch or ref for commit
 * @return {Promise<boolean>} true if a tsconfig.json file exists for the branch/ref
 */
async function shouldDownloadTypeScriptFolders (repoURL, branch) {
  const urlPath = `${repoURL}${branch}/ts/tsconfig.json`
  const tsConfigPath = join(PATH_TMP_DIRECTORY, branch, 'ts', 'tsconfig.json')
  const tsConfigResponse = await downloadFile(urlPath, tsConfigPath)

  return (tsConfigResponse.statusCode >= 200 && tsConfigResponse.statusCode < 300)
}

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
function getCustomFileContent (dependencies, globalsPath) {
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
    'import Highcharts from \'' + importFolder + globalsPath,
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
 * @param {Response} res Express response object.
 * @param {Request} req Express request object.
 */
async function handlerDefault (req, res) {
  let branch = await getBranch(req.path)
  let url = req.url
  const parts = req.query.parts
  let useGitDownloader = branch === 'master' || /^\/v[0-9]/.test(req.path) // version tags

  // If we can get it, save by commit sha
  // This also means we can use the degit downloader
  // (only works on latest commit in a branch)
  // Only `v8.0.0` gets saved by their proper names
  const { commit } = await getBranchInfo(branch)
  if (commit) {
    branch = commit.sha
    useGitDownloader = true
  }

  // If this is still not true, the request may be for a short SHA
  // Get the long form sha
  // Todo: find a way to check if it is the latest commit in the branch
  if (!useGitDownloader) {
    const { sha } = await getCommitInfo(branch)
    if (sha) {
      url = url.replace(branch, sha)
      branch = sha
    }
  }

  // Serve a file depending on the request URL.
  let result
  // If request has a query including parts, then create a custom file.
  if (parts) {
    result = await serveDownloadFile(URL_DOWNLOAD, branch, parts)
  } else {
    // Try to build the file
    result = await serveBuildFile(branch, url, useGitDownloader)
  }
  // If all else fails, then try to serve  a static file.
  if (!result || (!result.file && result.status !== 200)) {
    result = await serveStaticFile(branch, url)
  }
  if (result) {
    await updateBranchAccess(join(PATH_TMP_DIRECTORY, branch))
  }
  return respondToClient(result, res, req)
}

/**
 * Handle requests to health checker.
 * The Promise resolves when a response is sent to client.
 *
 * @param {Response} res Express response object.
 * @param {Request} req Express request object.
 */
async function handlerHealth (req, res) {
  return respondToClient(response.ok, res, req)
}

/**
 * Handle requests for icon file, responds with favicon.ico.
 * The Promise resolves when a response is sent to client.
 *
 * @todo Use express.static in stead if send file.
 * @param {Response} res Express response object.
 * @param {Request} req Express request object.
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
 * @param {Response} res Express response object.
 * @param {Request} req Express request object.
 */
async function handlerIndex (req, res) {
  const result = { file: join(__dirname, '/../views/index.html') }
  return respondToClient(result, res, req)
}

/**
 * Trigger cleanup by a get
 * The Promise resolves when a response is sent to client.
 *
 * @todo Use express.static in stead of send file.
 * @param {Response} res Express response object.
 * @param {Request} req Express request object.
 */
async function handlerCleanup (req, res) {
  if (req.url.includes('?true')) {
    const result = await cleanUp()
    res.status(200).send(result)
  }
  res.status(400).send()
}

/**
 * Handle requests from robots, responds with robots.txt.
 * The Promise resolves when a response is sent to client.
 *
 * @todo Use express.static in stead of send file.
 * @param {Response} res Express response object.
 * @param {Request} req Express request object.
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
 * @param {Response} res Express response object.
 * @param {Request} req Express request object.
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
        // await removeDirectory(pathCacheDirectory)
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
 * @param {string} requestURL The url which the request was sent to.
 */
async function serveBuildFile (branch, requestURL, useGitDownloader) {
  const type = getType(branch, requestURL)
  const file = getFile(branch, type, requestURL)

  // Respond with not found if the interpreter can not find a filename.
  if (file === false) {
    return response.notFound
  }

  const pathCacheDirectory = join(PATH_TMP_DIRECTORY, branch)
  const jsMastersDirectory = join(pathCacheDirectory, 'js', 'masters')
  const server = require('./server.js')

  const isMastersQuery = file.startsWith('masters/')
  const isMasterFile = await isMasterTSFile(file)
  const TSFileCacheLocation = join(
    isMasterFile && !isMastersQuery ? 'masters' : '',
    file.replace(isMasterFile ? '.js' : '.src.js', '.ts')
  )
  const tsMastersDirectory = join(pathCacheDirectory, 'ts', 'masters')

  // Check if file is there before we download anything
  let foundFile = checkFile(file)
  if (foundFile) return foundFile

  // If the branch is already being compiled, get that job
  let typescriptJob = server.getTypescriptJob(branch, TSFileCacheLocation)
  const isAlreadyDownloaded = typescriptJob ? true : (exists(jsMastersDirectory) || exists(tsMastersDirectory))

  // Download the source files if they are not found in the cache
  if (!isAlreadyDownloaded) {
    try {
      const downloadPromise = server.getDownloadJob(branch) || server.addDownloadJob(branch, useGitDownloader
        ? downloadSourceFolderGit(pathCacheDirectory, branch)
        : downloadSourceFolder(pathCacheDirectory, URL_DOWNLOAD, branch))
      if (!downloadPromise) throw new Error()
    } catch (error) {
      server.removeDownloadJob(branch)
      return response.error
    }
  }
  // Await the download if it exists
  await (server.getDownloadJob(branch) || Promise.resolve())

  const buildProject = isMastersQuery
  // Add a typescript job, if the corresponding ts file has been downloaded,
  // and the requested file is not downloaded
  if (
    exists(join(pathCacheDirectory, 'ts', buildProject ? '' : TSFileCacheLocation)) &&
    !checkFile(file) && !checkCompiled(file)
  ) {
    typescriptJob = server.getTypescriptJob(branch, TSFileCacheLocation) || await server.addTypescriptJob(branch, TSFileCacheLocation, buildProject)
  }

  // Wait for the Typescript compilation to finish
  await (typescriptJob || server.getTypescriptJob(branch, TSFileCacheLocation) || Promise.resolve())
    .catch(error => {
      // Fail gracefully
      log(2, `500: Typescript compilation failed:
${error.message}`)
      server.removeTypescriptJob(branch, TSFileCacheLocation)
    })

  // If the file is found, remove download and typescript jobs from the state
  foundFile = checkFile(file)
  if (foundFile) {
    server.removeDownloadJob(branch)
    server.removeTypescriptJob(branch, TSFileCacheLocation)
    return foundFile
  }

  const assemblyID = branch + (isMasterFile ? file : 'project')
  // Await the existing assembly, or add a new one
  // Remove registry entries on success or error
  const result = await (server.getAssemblyJob(assemblyID) || server.addAssemblyJob(assemblyID, assemble().catch((error) => {
    log(2, error.message)
    // If the assembler fails, we assume that the file can't be found
    return response.notFound
  }).finally(() => {
    log(0, `Finished assembling ${file} for commit ${branch}`)
    server.removeDownloadJob(branch)
    server.removeTypescriptJob(branch, TSFileCacheLocation)
    server.removeAssemblyJob(assemblyID)
  })))

  return result

  /* *
   *
   *  Scoped utility functions
   *
   * */

  /**
   * Assembles the source files
   */
  async function assemble () {
    const pathOutputFolder = join(pathCacheDirectory, 'output')
    const pathOutputFile = join(
      pathOutputFolder, (type === 'css' ? 'js' : ''), file
    )
    // Build the distribution file if it is not found in cache.
    if (!exists(pathOutputFile)) {
      const files = await getFileNamesInDirectory(jsMastersDirectory)
      const fileOptions = getFileOptions(files, join(pathCacheDirectory, 'js'))
      build({
        // TODO: Remove trailing slash when assembler has fixed path concatenation
        base: jsMastersDirectory + '/',
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
   * Checks if the file is in the ts/masters folder.
   * If the ts/masters folder is downloaded, it will check that.
   * Otherwise it will check Github
   * @param {string} file
   */
  async function isMasterTSFile (file) {
    // If ts folder is downloaded, check that
    if (exists(join(pathCacheDirectory, 'ts', 'masters'))) {
      const masterFiles = await getFileNamesInDirectory(join(pathCacheDirectory, 'ts', 'masters'), true) || []
      return masterFiles.some(product => file.replace(/^masters\//, '').replace('.js', '.ts').startsWith(product))
    }
    // Otherwise check github
    const remoteURL = URL_DOWNLOAD + branch + '/ts/masters/' + file.replace('.js', '.ts')
    return urlExists(remoteURL)
  }

  /**
  * Check if the file is already built, and return it if that is the case
  * @param {string} file
  */
  function checkFile (file) {
    const compiledFilePath = join(pathCacheDirectory, 'output', file)
    const cachedJSFile =
      exists(compiledFilePath) && !isMastersQuery
        ? compiledFilePath
        : join(pathCacheDirectory, 'js', isMastersQuery ? file : file.replace('.src.js', '.js'))

    if (exists(cachedJSFile)) {
      return { file: cachedJSFile }
    }
  }

  function checkCompiled (file) {
    const compiledMasterFile = join(pathCacheDirectory, 'js/masters', file)
    if (exists(compiledMasterFile)) {
      return { file: compiledMasterFile }
    }
  }
}

/**
 * Interprets the request URL and serves a static file if found.
 * The Promise resolves with an object containing information on the response.
 *
 * @param {string} branch
 * @param {string} requestURL The url which the request was sent to.
 */
async function serveStaticFile (branch, requestURL) {
  const file = getFile(branch, 'classic', requestURL)

  // Respond with not found if the interpreter can not find a filename.
  if (file === false) {
    return response.notFound
  }

  const pathFile = join(PATH_TMP_DIRECTORY, branch, 'output', file)
  // Download the file if it is not already available in cache.
  if (!exists(pathFile)) {
    const urlFile = `${URL_DOWNLOAD}${branch}/js/${file}`
    const download = await downloadFile(urlFile, pathFile)
    if (download.statusCode !== 200) {
      // we don't always know if it is a static file before we have tried to download it.
      // check if this branch contains TypeScript config (we then need to compile it).
      if (file.split('/').length <= 1 || await shouldDownloadTypeScriptFolders(URL_DOWNLOAD, branch)) {
        return serveBuildFile(branch, requestURL)
      }
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
  if (!exists(join(pathCacheDirectory, 'js/masters')) || await shouldDownloadTypeScriptFolders(repositoryURL, branch)) {
    await downloadSourceFolder(pathCacheDirectory, repositoryURL, branch)
    try {
      await compileTypeScriptProject(branch)
    } catch (err) {
      throw new Error(`500: Typescript compilation failed with error:
${err.message}`)
    }
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
    const globalsLocation = await getGlobalsLocation(join(pathCacheDirectory, 'js/masters', 'highcharts.src.js'))
    const content = getCustomFileContent(parts, globalsLocation)
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
  handlerCleanup,
  handlerRobots,
  handlerUpdate
}
