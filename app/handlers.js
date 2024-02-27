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
const { downloadFile, downloadSourceFolder, urlExists, getBranchInfo, getCommitInfo } = require('./download.js')
const { log } = require('./utilities')

const {
  exists,
  getFileNamesInDirectory,
  writeFile,
  cleanUp,
  removeDirectory
} = require('./filesystem.js')

const { readFile } = require('fs/promises')
const {
  getBranch,
  getFile,
  getFileOptions,
  getType
} = require('./interpreter.js')
const { response } = require('./message.json')
const { validateWebHook } = require('./webhook.js')
const {
  buildModules,
  buildDistFromModules
} = require('@highcharts/highcharts-assembler/src/build.js')
const { join } = require('path')
const directoryTree = require('directory-tree')
const { JobQueue } = require('./JobQueue')
const { existsSync } = require('node:fs')

// Constants
const PATH_TMP_DIRECTORY = join(__dirname, '../tmp')
const URL_DOWNLOAD = `https://raw.githubusercontent.com/${repo}/`

const queue = new JobQueue()

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

  // Try to serve  a static file.
  result = await serveStaticFile(branch, url)

  if (result.status !== 200) {
    // Try to build the file
    result = await serveBuildFile(branch, url, useGitDownloader)
  }

  // await updateBranchAccess(join(PATH_TMP_DIRECTORY, branch))

  res.header('ETag', branch)
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
    return respondToClient({ status: 200, body: result }, res, req)
  }
  return respondToClient(response.error, res, req)
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
  let result = response.notFound

  // Just check the user agent for now
  if (('' + req.get('user-agent')) === 'GitHub-Hookshot/0a3a2d2') {
    result = response.ok
  }

  // Do the more expensive check as a fallback
  if (result.status !== 200) {
    const hook = validateWebHook(req, secureToken)
    if (hook.valid) {
      result = response.ok
    }
  }

  return respondToClient(result, res, req)
}

/**
 * Respond to the client with a status and body, or a file transfer.
 * The Promise resolves when a response is sent to client.
 *
 * @param {object} result Object containing information of the response.
 * @param {import('express').Response} response Express response object.
 * @param {import('express').Request} request Express request object.
 */
async function respondToClient (result, response, request) {
  const { body, file, status } = result
  // Make sure connection is not lost before attemting a response.
  if (request.destroyed || !request) {
    console.log('Connection lost')
    return
  }

  // Set response headers to allow all origins.
  response.header('Access-Control-Allow-Origin', '*')
  response.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept'
  )

  // max age one hour
  response.header('Cache-Control', 'max-age=3600')
  response.header('CDN-Cache-Control', 'max-age=3600')

  if (file) {
    await new Promise((resolve, reject) => {
      response.sendFile(file, (err) => {
        return (err ? reject(err) : resolve(true))
      })
    })

    return
  }

  return response.status(status).send(body)
}

/**
 * Interprets the request URL, builds a distribution file if found, and serves
 * the result.
 * Downloads the source files for the given branch/tag/commit if they are not
 * found in the cache.
 * The Promise resolves with an object containing information on the response.
 * @param {string} branch
 * @param {string} requestURL The url which the request was sent to.
 */
async function serveBuildFile (branch, requestURL, useGitDownloader = true) {
  const type = getType(branch, requestURL)
  const file = getFile(branch, type, requestURL)

  // Respond with not found if the interpreter can not find a filename.
  if (file === false) {
    return response.missingFile
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

  if (!isAlreadyDownloaded) {
    const maybeResponse = await queue.addJob(
      'download',
      branch,
      {
        func: downloadSourceFolder,
        args: [
          pathCacheDirectory, URL_DOWNLOAD, branch
        ]
      }
    ).catch(error => {
      if (error.name === 'QueueFullError') {
        return { status: 503, body: error.message }
      }

      return { status: 500 }
    })

    if (maybeResponse.status) {
      return maybeResponse
    }
  }

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
    server.removeTypescriptJob(branch, TSFileCacheLocation)
    return foundFile
  }

  const assemblyID = branch + (isMasterFile ? file : 'project')
  // Await the existing assembly, or add a new one
  // Remove registry entries on success or error
  const result = await (server.getAssemblyJob(assemblyID) || server.addAssemblyJob(assemblyID, assemble().catch((error) => {
    log(2, error.message)
    // If the assembler fails, we assume that the file can't be found
    return response.invalidBuild
  }).finally(() => {
    log(0, `Finished assembling ${file} for commit ${branch}`)
    server.removeTypescriptJob(branch, TSFileCacheLocation)
    server.removeAssemblyJob(assemblyID)
  })))

  return result

  /**
    * Assembles the source files
    */
  async function assemble () {
    const pathOutputFolder = join(pathCacheDirectory, 'output')
    const pathOutputFile = join(
      pathOutputFolder, (type === 'css' ? 'js' : ''), file || ''
    )
    // Build the distribution file if it is not found in cache.
    if (!exists(pathOutputFile)) {
      const files = await getFileNamesInDirectory(jsMastersDirectory)
      const fileOptions = getFileOptions(files, join(pathCacheDirectory, 'js'))
      const namespace = 'Highcharts'
      const debug = true
      try {
        buildModules({
          base: join(pathCacheDirectory, 'js') + '/',
          type: [type],
          namespace,
          output: pathOutputFolder,
          version: branch
        })

        buildDistFromModules({
          base: join(pathOutputFolder, 'es-modules', 'masters') + '/',
          debug,
          fileOptions,
          files,
          namespace,
          output: pathOutputFolder,
          type: [type],
          version: branch
        })
      } catch (error) {
        console.log('assembler error: ', error)
      }

      // Workaround for code.highcharts.com version
      // TODO: could look up relevant version number for older commits
      const contents = await readFile(pathOutputFile, 'utf-8')
            const toReplace = 'code.highcharts.com\/' + branch + '\/' // eslint-disable-line
      if (contents && contents.includes(toReplace)) {
        await writeFile(
          pathOutputFile,
          contents.replace(new RegExp(toReplace, 'g'), 'code.highcharts.com/')
        )
      }
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
    return response.missingFile
  }

  if (file.endsWith('.css')) {
    // TODO: add fs check before download
    const fileLocation = join(PATH_TMP_DIRECTORY, branch, file)
    if (!existsSync(fileLocation)) {
      const urlFile = `${URL_DOWNLOAD}${branch}/${file}`
      const download = await downloadFile(urlFile, fileLocation)
      if (download.success) {
        return { status: 200, file: fileLocation }
      }
    } else {
      return { status: 200, file: fileLocation }
    }
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
      return response.missingFile
    }
  }

  // Return path to file location in the cache.
  return { status: 200, file: pathFile }
}

function printTreeChildren (children, level = 1, carry) {
  return children.reduce((carry, child) => {
    let padding = ''

    while (padding.length < level) {
      padding += '-'
    }

    carry.push(padding + child.name)

    if (child.children) {
      printTreeChildren(child.children, level + 1, carry)
    }

    return carry
  }, carry || []).join('\n')
}

async function handlerFS (req, res) {
  if (req.url.includes('?commit=')) {
    const comm = req.url.match(/commit=(.+?(?=&|$))/)
    if (comm.length > 1) {
      const commit = comm[1]
      const tree = directoryTree(join(PATH_TMP_DIRECTORY, commit, 'output'))
      if (tree && tree.children) {
        const textTree = printTreeChildren(tree.children)
        return respondToClient({ status: 200, body: `<pre>${textTree}</pre>` }, res, req)
      }
    }
    return respondToClient({ status: 404, body: 'no output folder found for this commit' }, res, req)
  }

  return respondToClient(response.missingFile, res, req)
}

async function handlerRemoveFiles (req, res) {
  const commit = req.params['0']
  const commitDir = join(PATH_TMP_DIRECTORY, commit)
  const referer = req.get('referer')
  const userAgent = req.get('user-agent')

  if (
    userAgent.includes('curl') &&
        referer &&
        referer === 'highcharts.local'
  ) {
    if (commit) {
      const result = await removeDirectory(commitDir)
        .catch(error => {
          return { error: error.message.split(':')[0] }
        })

      return respondToClient(
        {
          status: 200,
          body: result?.error ? result.error : commit
        },
        res,
        req
      )
    }
  }

  return respondToClient({ status: 400, body: 'invalid request' }, res, req)
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
  handlerUpdate,
  handlerFS,
  handlerRemoveFiles
}
