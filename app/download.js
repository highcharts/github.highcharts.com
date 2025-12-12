/**
 * Contains all procedures related to requests and downloading of files.
 * @author Jon Arild Nygard
 * @todo Add license
 */
'use strict'

// Import dependencies, sorted by path.
const { token, repo } = require('../config.json')
const { writeFile } = require('./filesystem.js')
const { log } = require('./utilities.js')
const { get: httpsGet } = require('https')
const { join } = require('path')
const authToken = token ? { Authorization: `token ${token}` } : {}

const degit = require('tiged')

const DEFAULT_CACHE_TTL = Number(process.env.GITHUB_LOOKUP_CACHE_TTL || 60_000)
const NEGATIVE_CACHE_TTL = Number(process.env.GITHUB_LOOKUP_NEGATIVE_CACHE_TTL || 10_000)

const branchInfoCache = new Map()
const commitInfoCache = new Map()
let githubRequest

/**
 * Global rate limit state tracking.
 * When rate limit is exhausted, we store the reset time to avoid
 * making unnecessary requests that will fail.
 */
const rateLimitState = {
  remaining: undefined,
  reset: undefined
}

/**
 * Update the global rate limit state from response headers.
 * @param {number|undefined} remaining
 * @param {number|undefined} reset
 */
function updateRateLimitState (remaining, reset) {
  if (remaining !== undefined) {
    rateLimitState.remaining = remaining
  }
  if (reset !== undefined) {
    rateLimitState.reset = reset
  }
}

/**
 * Check if we are currently rate limited.
 * Returns an object with `limited` boolean and `retryAfter` seconds if limited.
 * @returns {{ limited: boolean, retryAfter: number|undefined, reset: number|undefined }}
 */
function isRateLimited () {
  const now = Math.floor(Date.now() / 1000)

  // If reset time has passed, we're no longer rate limited
  if (rateLimitState.reset && now >= rateLimitState.reset) {
    rateLimitState.remaining = undefined
    rateLimitState.reset = undefined
    return { limited: false, retryAfter: undefined, reset: undefined }
  }

  // If we know we have no remaining requests
  if (rateLimitState.remaining === 0 && rateLimitState.reset) {
    const retryAfter = Math.max(0, rateLimitState.reset - now)
    return { limited: true, retryAfter, reset: rateLimitState.reset }
  }

  return { limited: false, retryAfter: undefined, reset: undefined }
}

/**
 * Get the current rate limit state for external inspection.
 * @returns {{ remaining: number|undefined, reset: number|undefined, limited: boolean, retryAfter: number|undefined }}
 */
function getRateLimitState () {
  const { limited, retryAfter } = isRateLimited()
  return {
    remaining: rateLimitState.remaining,
    reset: rateLimitState.reset,
    limited,
    retryAfter
  }
}

/**
 * Extracts rate limit information from a headers object.
 * @param {import('http').IncomingHttpHeaders|undefined} headers
 */
function getRateLimitInfo (headers) {
  if (!headers) {
    return { remaining: undefined, reset: undefined }
  }

  const remainingHeader = headers['x-ratelimit-remaining'] ?? headers['X-RateLimit-Remaining']
  const resetHeader = headers['x-ratelimit-reset'] ?? headers['X-RateLimit-Reset']

  const remaining = Number.parseInt(remainingHeader, 10)
  const reset = Number.parseInt(resetHeader, 10)

  return {
    remaining: Number.isNaN(remaining) ? undefined : remaining,
    reset: Number.isNaN(reset) ? undefined : reset
  }
}

/**
 * Logs a warning when rate limit remaining is depleted.
 * Also updates the global rate limit state.
 * @param {import('http').IncomingHttpHeaders|undefined} headers
 * @param {string} context
 * @returns {{ remaining: number|undefined, reset: number|undefined }}
 */
function logRateLimitIfDepleted (headers, context) {
  const { remaining, reset } = getRateLimitInfo(headers)

  // Update global state
  updateRateLimitState(remaining, reset)

  if (remaining === 0) {
    const resetTime = reset
      ? new Date(reset * 1000).toISOString()
      : 'unknown'
    log(2, `GitHub API rate limit exhausted while ${context}. Next reset: ${resetTime}`)
  }

  return { remaining, reset }
}

/**
 * Resolve a value from cache or execute the provided fetcher.
 * Shares in-flight fetches and caches both positive and negative responses.
 * @template T
 * @param {Map<string, { expires?: number, value?: T, promise?: Promise<T> }>} cache
 * @param {string} key
 * @param {() => Promise<T>} fetcher
 * @returns {Promise<T>}
 */
function getWithCache (cache, key, fetcher) {
  const now = Date.now()
  const cached = cache.get(key)

  if (cached) {
    if (cached.expires && cached.expires > now && ('value' in cached)) {
      return Promise.resolve(cached.value)
    }
    if (cached.promise) {
      return cached.promise
    }
  }

  const promise = fetcher().then(result => {
    const ttl = result ? DEFAULT_CACHE_TTL : NEGATIVE_CACHE_TTL
    cache.set(key, {
      value: result,
      expires: Date.now() + ttl
    })
    return result
  }).catch(error => {
    cache.delete(key)
    throw error
  })

  cache.set(key, { promise })
  return promise
}

/**
 * Downloads the content of a url and writes it to the given output path.
 * The Promise is resolved with an object containing information of the result
 * of the process.
 *
 * @param {string} url The URL location to the content to download.
 * @param {string} outputPath The path to output the content at the URL.
 */
async function downloadFile (url, outputPath) {
  const { body, statusCode, headers } = await get(url)
  const result = {
    outputPath,
    statusCode,
    success: false,
    url
  }

  if (statusCode === 200) {
    log(0, `Downloading ${url}`)
    await writeFile(outputPath, body)
    result.success = true
  }
  const { remaining, reset } = logRateLimitIfDepleted(headers, `downloading ${url}`)
  if (typeof remaining === 'number') {
    result.rateLimitRemaining = remaining
  }
  if (typeof reset === 'number') {
    result.rateLimitReset = reset
  }

  return result
}

/**
 * Downloads a list of files relative to the base URL. The baseURL joined with
 * a subpath points to a URL, the content of the URL will be outputted to the
 * joined path of the output directory and the subpath.
 * The Promise is resolved with an array of objects containing information of
 * their result of the process.
 *
 * @param {string} baseURL The base URL for each subpath.
 * @param {[string]} subpaths List of pathnames relative to the base URL.
 * @param {string} outputDir The directory to output the content of each URL.
 */
async function downloadFiles (baseURL, subpaths, outputDir) {
  const chunkSize = 10
  const results = []

  for (let i = 0; i < subpaths.length; i += chunkSize) {
    const chunk = subpaths.slice(i, i + chunkSize)

    const promises = chunk.map(path => downloadFile(
      `${baseURL}/${path}`,
      join(outputDir, path)
    ))

    results.push(...await Promise.all(promises))
  }

  return results
}

/**
 * Download all the files in the css and js/ts folder in the given branch of a
 * repository.
 * The Promise resolves when all the files have been downloaded.
 *
 * @param {string} outputDir The directory to output the js files.
 * @param {string} repositoryURL The URL to the repository of files in raw
 * format.
 * @param {string} branch The name of the branch the files are located in.
 */
async function downloadSourceFolder (outputDir, repositoryURL, branch) {
  log(0, `Downloading source for commit ${branch} using GH api`)
  const url = `${repositoryURL}${branch}`
  const files = await getDownloadFiles(branch)
  const responses = await downloadFiles(url, files, outputDir)
  const errors = responses
    .filter(({ statusCode }) => statusCode !== 200)
    .map(({ url, statusCode }) => `${statusCode}: ${url}`)

  // Log possible errors
  if (errors.length) {
    log(2, `Some files did not download in branch "${branch}"\n${errors.join('\n')
            }`)
  }
}

/**
 * Download the source folder using git (via https://github.com/tiged/tiged)
 * @param {string} outputDir
 * @param {string} branch
 * @returns Promise<[{}]>
 */
async function downloadSourceFolderGit (outputDir, branch, mode = 'tar') {
  log(0, `Downloading source for commit ${branch} using git`)

  const responses = []
  const promises = ['css', 'js', 'ts'].map(folder => {
    const outputPath = join(outputDir, folder)
    const uri = `${repo}/${folder}#${branch}`
    return new Promise((resolve, reject) => {
      const result = {
        success: false,
        statusCode: 400,
        url: uri
      }
      try {
        const emitter = degit(uri, {
          cache: false,
          force: true,
          verbose: false,
          mode
        })
        emitter.clone(outputPath).then(() => {
          result.success = true
          result.statusCode = 200
        }).catch((error) => {
          // Error here is mostly degit not finding the branch
          log(0, error.message)
        }).finally(() => {
          return resolve(result)
        })
      } catch (error) {
        log(0, error)
        return resolve(result)
      }
    })
  })

  /* eslint-disable */
    for await (const promise of promises) {
        responses.push(promise)
    }
    /* eslint-disable */

    const errors = responses
        .filter(({ statusCode }) => statusCode !== 200)
        .map(({ url, statusCode }) => `${statusCode}: ${url}`)

    // Log possible errors
    if (errors.length) {
        log(2, `Some files did not download in branch "${branch}"\n${errors.join('\n')
            }`)
    }

    return responses
}

/**
 * An asynchronous version of https.get, with encoding set to utf8.
 * The Promise resolves with an object containing the status code and the
 * response body.
 *
 * @param {object|string} options Can either be an https request options object,
 * or an url string.
 */
function get(options) {
    return new Promise((resolve, reject) => {
        const request = httpsGet(options, response => {
            const body = []
            response.setEncoding('utf8')
            response.on('data', (data) => { body.push(data) })
            response.on('end', () =>
                resolve({
                    statusCode: response.statusCode,
                    body: body.join(''),
                    headers: response.headers
                })
            )
        })
        request.on('error', reject)
        request.end()
    })
}

githubRequest = get

/**
 * Gives a list of all the source files in the given branch in the repository.
 * The Promise resolves with a list of objects containing information on each
 * source file.
 *
 * @param {string} branch The name of the branch the files are located in.
 */
async function getDownloadFiles(branch) {
    const promises = [
      'css',
      'ts',
      'js',
      'tools/webpacks',
      'tools/libs'
    ].map(folder => getFilesInFolder(folder, branch))

    const folders = await Promise.all(promises)
    const files = [].concat.apply([], folders)

    const extensions = ['ts', 'js', 'css', 'scss', 'json', 'mjs']

    const isValidFile = ({ path, size }) =>
        (extensions.some(ext => path.endsWith('.' + ext))) && size > 0
    return files.filter(isValidFile).map(({ path }) => path)
}

/**
 * Gives a list of all the files in a directory in the given branch in the
 * repository.
 * The Promise resolves with a list of objects containing information on each of
 * the files in the directory.
 *
 * @param {string} path The path to the directory.
 * @param {string} branch The name of the branch the files are located in.
 */
async function getFilesInFolder(path, branch) {
    const { body, statusCode, headers } = await get({
        hostname: 'api.github.com',
        path: `/repos/${repo}/contents/${path}?ref=${branch}`,
        headers: {
            'user-agent': 'github.highcharts.com',
            ...authToken
        }
    })
    logRateLimitIfDepleted(headers, `listing files in ${path} for ${branch}`)

    if (statusCode !== 200) {
        console.warn(`Could not get files in folder ${path}. This is only an issue if the requested path exists in the branch ${branch}. (HTTP ${statusCode})`)
    }

    let promises = []
    if (statusCode === 200) {
        promises = JSON.parse(body).map(obj => {
            const name = path + '/' + obj.name
            return (
                (obj.type === 'dir')
                    ? getFilesInFolder(name, branch)
                    : [{
                        download: obj.download_url,
                        path: name,
                        size: obj.size,
                        type: obj.type
                    }]
            )
        })
    }
    const arr = await Promise.all(promises)
    return arr.reduce((arr1, arr2) => arr1.concat(arr2), [])
}

/**
 * Check if a given URL responds with a status 200.
 * The Promise resolves with true if the URL responds with status 200, otherwise
 * false.
 *
 * @param  {string} url The URL to check if exists.
 */
async function urlExists(url) {
    try {
        const response = await get(url)
        return response.statusCode === 200
    } catch (e) {
        return false
    }
}

/**
 * Gets branch info from the github api.
 * @param {string} branch
 * The branch name
 *
 * @returns {Promise<({}|false)>}
 * The branch info object, or false if not found
 */
async function getBranchInfo (branch) {
  return getWithCache(branchInfoCache, branch, async () => {
    const { body, statusCode, headers } = await githubRequest({
      hostname: 'api.github.com',
      path: `/repos/${repo}/branches/${branch}`,
      headers: {
        'user-agent': 'github.highcharts.com',
        ...authToken
      }
    })
    logRateLimitIfDepleted(headers, `fetching branch info for ${branch}`)
    if (statusCode === 200) {
      return JSON.parse(body)
    }
    return false
  })
}


/**
 * Gets commit info from the github api.
 * @param {string} commit
 * The commit sha, long or short
 *
 * @returns {Promise<({}|false)>}
 * The commit info object, or false if not found
 */
async function getCommitInfo (commit) {
  return getWithCache(commitInfoCache, commit, async () => {
    const { body, statusCode, headers } = await githubRequest({
      hostname: 'api.github.com',
      path: `/repos/${repo}/commits/${commit}`,
      headers: {
        'user-agent': 'github.highcharts.com',
        ...authToken
      }
    })
    logRateLimitIfDepleted(headers, `fetching commit info for ${commit}`)
    if (statusCode === 200) {
      return JSON.parse(body)
    }
    return false
  })
}

function setGitHubRequest (fn) {
  githubRequest = typeof fn === 'function' ? fn : get
}

function clearGitHubCache () {
  branchInfoCache.clear()
  commitInfoCache.clear()
}

/**
 * Reset the rate limit state. Used for testing.
 */
function clearRateLimitState () {
  rateLimitState.remaining = undefined
  rateLimitState.reset = undefined
}

/**
 * Set rate limit state directly. Used for testing.
 * @param {number|undefined} remaining
 * @param {number|undefined} reset
 */
function setRateLimitState (remaining, reset) {
  rateLimitState.remaining = remaining
  rateLimitState.reset = reset
}

// Export download functions
module.exports = {
    downloadFile,
    downloadFiles,
    downloadSourceFolder,
    downloadSourceFolderGit,
    getDownloadFiles,
    httpsGetPromise: get,
    urlExists,
    getBranchInfo,
    getCommitInfo,
    isRateLimited,
    getRateLimitState,
    __setGitHubRequest: setGitHubRequest,
    __clearGitHubCache: clearGitHubCache,
    __clearRateLimitState: clearRateLimitState,
    __setRateLimitState: setRateLimitState
}
