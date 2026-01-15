/**
 * Contains all procedures related to requests and downloading of files.
 * @author Jon Arild Nygard
 * @todo Add license
 */
// Import dependencies, sorted by path.
const { repo } = require('../config.json')
const { createDirectory, exists, removeDirectory, writeFile } = require('./filesystem.js')
const { log } = require('./utilities.js')
const { execFile } = require('node:child_process')
const { unlink } = require('node:fs/promises')
const { join } = require('node:path')
const { promisify } = require('node:util')

const DEFAULT_CACHE_TTL = Number(process.env.GITHUB_LOOKUP_CACHE_TTL || 60_000)
const NEGATIVE_CACHE_TTL = Number(process.env.GITHUB_LOOKUP_NEGATIVE_CACHE_TTL || 10_000)
const DEFAULT_BRANCH = process.env.DEFAULT_BRANCH || 'master'
const GIT_AUTH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GIT_TOKEN

const branchInfoCache = new Map()
const commitInfoCache = new Map()
let defaultBranchCache
let githubRequest

const execFileAsync = promisify(execFile)
const PATH_TMP_DIRECTORY = join(__dirname, '../tmp')
const GIT_CACHE_DIR = join(PATH_TMP_DIRECTORY, 'git-cache')
const GIT_REPO_DIR = join(GIT_CACHE_DIR, 'repo')
const REQUIRED_GIT_PATHS = ['css', 'js', 'ts', 'tools/webpacks', 'tools/libs']
const GIT_MAX_BUFFER = 50 * 1024 * 1024

function getRepoUrl () {
  if (!GIT_AUTH_TOKEN) {
    return `https://github.com/${repo}.git`
  }

  const token = encodeURIComponent(GIT_AUTH_TOKEN)
  return `https://x-access-token:${token}@github.com/${repo}.git`
}

const disabledGitHubRequest = () => Promise.reject(
  new Error('GitHub API requests are disabled')
)

githubRequest = disabledGitHubRequest

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

async function execGit (args, options = {}) {
  const { stdout } = await execFileAsync('git', args, {
    maxBuffer: GIT_MAX_BUFFER,
    ...options
  })
  return stdout.trim()
}

async function ensureGitRepo () {
  const gitDir = join(GIT_REPO_DIR, '.git')
  if (exists(gitDir)) {
    return
  }

  if (exists(GIT_REPO_DIR)) {
    await removeDirectory(GIT_REPO_DIR)
  }

  await createDirectory(GIT_CACHE_DIR)

  // Clone with filter to avoid downloading blobs upfront (partial clone)
  await execGit([
    'clone',
    '--no-checkout',
    '--filter=blob:none',
    getRepoUrl(),
    GIT_REPO_DIR
  ], {
    cwd: GIT_CACHE_DIR
  })

  // Enable sparse checkout for the paths we need
  await execGit(['sparse-checkout', 'init', '--cone'], {
    cwd: GIT_REPO_DIR
  })

  await execGit(['sparse-checkout', 'set', ...REQUIRED_GIT_PATHS], {
    cwd: GIT_REPO_DIR
  })
}

async function getDefaultBranchName () {
  if (defaultBranchCache) {
    return defaultBranchCache
  }

  await ensureGitRepo()

  const headRef = await execGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], {
    cwd: GIT_REPO_DIR
  }).catch(() => '')

  const match = headRef.match(/refs\/remotes\/origin\/(.+)$/)
  let branch = match ? match[1] : ''

  if (!branch) {
    const candidates = [DEFAULT_BRANCH, 'main', 'master']
      .filter((candidate, index, list) => list.indexOf(candidate) === index)

    for (const candidate of candidates) {
      const exists = await execGit(
        ['show-ref', '--verify', `refs/remotes/origin/${candidate}`],
        { cwd: GIT_REPO_DIR }
      ).then(() => true).catch(() => false)

      if (exists) {
        branch = candidate
        break
      }
    }
  }

  defaultBranchCache = branch || DEFAULT_BRANCH
  return defaultBranchCache
}

async function syncMaster () {
  await ensureGitRepo()
  await execGit(['fetch', 'origin', '--prune', '--tags'], {
    cwd: GIT_REPO_DIR
  })
  const defaultBranch = await getDefaultBranchName()
  await execGit(['checkout', '-B', defaultBranch, `origin/${defaultBranch}`], {
    cwd: GIT_REPO_DIR
  })
}

function isCommitHash (ref) {
  return /^[0-9a-f]{7,40}$/i.test(ref)
}

function getUnqualifiedRef (ref) {
  return ref
    .replace(/^origin\//, '')
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\/origin\//, '')
    .replace(/^refs\/tags\//, '')
}

function getRemoteRefCandidates (ref) {
  if (ref.startsWith('refs/')) {
    return [ref]
  }

  const name = getUnqualifiedRef(ref)

  if (ref.startsWith('origin/')) {
    return [`refs/remotes/origin/${name}`]
  }

  return [
    `refs/remotes/origin/${name}`,
    `refs/tags/${name}`
  ]
}

async function remoteRefExists (ref) {
  const candidates = getRemoteRefCandidates(ref)

  for (const candidate of candidates) {
    const exists = await execGit(['show-ref', '--verify', candidate], {
      cwd: GIT_REPO_DIR
    }).then(() => true).catch(() => false)

    if (exists) {
      return true
    }
  }

  return false
}

async function fetchRef (ref) {
  await ensureGitRepo()

  if (!ref) {
    return false
  }

  const unqualifiedRef = getUnqualifiedRef(ref)
  const isTagRef = ref.startsWith('refs/tags/')
  const isRemoteRef = ref.startsWith('origin/') || ref.startsWith('refs/remotes/')

  if (!isCommitHash(ref) && !isTagRef && !isRemoteRef) {
    const refspec = `+refs/heads/${unqualifiedRef}:refs/remotes/origin/${unqualifiedRef}`
    const fetched = await execGit(['fetch', 'origin', '--prune', '--tags', refspec], {
      cwd: GIT_REPO_DIR
    }).then(() => true).catch(() => false)

    if (fetched && await remoteRefExists(unqualifiedRef)) {
      return true
    }
  }

  if (!isCommitHash(ref)) {
    const tagRefspec = `+refs/tags/${unqualifiedRef}:refs/tags/${unqualifiedRef}`
    const tagFetched = await execGit(['fetch', 'origin', '--prune', tagRefspec], {
      cwd: GIT_REPO_DIR
    }).then(() => true).catch(() => false)

    if (tagFetched && await remoteRefExists(`refs/tags/${unqualifiedRef}`)) {
      return true
    }
  }

  const fetched = await execGit(['fetch', 'origin', '--prune', '--tags', ref], {
    cwd: GIT_REPO_DIR
  }).then(() => true).catch(() => false)

  if (!fetched) {
    return false
  }

  if (isCommitHash(ref)) {
    return true
  }

  return remoteRefExists(ref)
}

async function resolveGitRef (ref) {
  if (!ref) {
    return null
  }

  await ensureGitRepo()

  const candidates = new Set([ref])
  if (ref === 'master' || ref === 'main') {
    const defaultBranch = await getDefaultBranchName()
    if (defaultBranch) {
      candidates.add(defaultBranch)
    }
    if (ref === 'master') {
      candidates.add('main')
    }
    if (ref === 'main') {
      candidates.add('master')
    }
  }

  const resolveCandidates = []
  const resolveCandidateSet = new Set()
  const addResolveCandidate = (candidate) => {
    if (!resolveCandidateSet.has(candidate)) {
      resolveCandidateSet.add(candidate)
      resolveCandidates.push(candidate)
    }
  }

  for (const candidate of candidates) {
    addResolveCandidate(candidate)

    if (candidate.startsWith('origin/')) {
      addResolveCandidate(`refs/remotes/${candidate}`)
      continue
    }

    if (!isCommitHash(candidate)) {
      addResolveCandidate(`origin/${candidate}`)
      addResolveCandidate(`refs/remotes/origin/${candidate}`)
      addResolveCandidate(`refs/tags/${candidate}`)
    }
  }

  for (const candidate of resolveCandidates) {
    try {
      return await execGit(['rev-parse', '--verify', `${candidate}^{commit}`], {
        cwd: GIT_REPO_DIR
      })
    } catch (error) {
    }
  }

  if (await fetchRef(ref)) {
    for (const candidate of resolveCandidates) {
      try {
        return await execGit(['rev-parse', '--verify', `${candidate}^{commit}`], {
          cwd: GIT_REPO_DIR
        })
      } catch (error) {
      }
    }
  }

  log(1, `Failed resolving ref ${ref}`)
  return null
}

async function pathExistsInRepo (ref, path) {
  const resolvedRef = await resolveGitRef(ref)
  if (!resolvedRef) {
    return false
  }

  try {
    await execGit(['cat-file', '-e', `${resolvedRef}:${path}`], {
      cwd: GIT_REPO_DIR
    })
    return true
  } catch (error) {
    return false
  }
}

async function exportGitArchive (ref, outputDir) {
  const resolvedRef = await resolveGitRef(ref)
  if (!resolvedRef) {
    throw new Error(`Unable to resolve git ref ${ref}`)
  }

  const existingPaths = []
  for (const path of REQUIRED_GIT_PATHS) {
    if (await pathExistsInRepo(resolvedRef, path)) {
      existingPaths.push(path)
    }
  }

  if (!existingPaths.length) {
    throw new Error(`No exportable paths found for ${resolvedRef}`)
  }

  await createDirectory(outputDir)

  const archivePath = join(GIT_CACHE_DIR, `${resolvedRef}-${Date.now()}.tar`)
  await execGit([
    'archive',
    '--format=tar',
    '--output',
    archivePath,
    resolvedRef,
    ...existingPaths
  ], {
    cwd: GIT_REPO_DIR
  })

  await execFileAsync('tar', ['-xf', archivePath, '-C', outputDir])
  await unlink(archivePath).catch(() => {})

  return {
    ref: resolvedRef,
    paths: existingPaths
  }
}

async function exportGitFile (ref, filePath, outputPath) {
  const resolvedRef = await resolveGitRef(ref)
  if (!resolvedRef) {
    return { statusCode: 404, success: false }
  }

  const existsInRepo = await pathExistsInRepo(resolvedRef, filePath)
  if (!existsInRepo) {
    return { statusCode: 404, success: false }
  }

  const contents = await execGit(['show', `${resolvedRef}:${filePath}`], {
    cwd: GIT_REPO_DIR
  })
  await writeFile(outputPath, contents)

  return { statusCode: 200, success: true }
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

function parseGitRawUrl (url) {
  try {
    const parsed = new URL(url)
    const parts = parsed.pathname.split('/').filter(Boolean)
    if (parts.length < 4) {
      return null
    }

    const ref = parts[2]
    const filePath = parts.slice(3).join('/')

    return { ref, filePath }
  } catch (error) {
    return null
  }
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
  if (!url || !outputPath) {
    throw new Error('Invalid download request')
  }

  const parsed = parseGitRawUrl(url)
  if (!parsed) {
    throw new Error('Invalid download request')
  }

  const { ref, filePath } = parsed
  log(0, `Downloading ${filePath} from ${ref} using git`)

  const result = await exportGitFile(ref, filePath, outputPath)
  return {
    outputPath,
    statusCode: result.statusCode,
    success: result.success,
    url
  }
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
  log(0, `Downloading source for commit ${branch} using git`)

  const hasSources = exists(join(outputDir, 'ts')) || exists(join(outputDir, 'js'))
  if (hasSources) {
    return { statusCode: 200, success: true }
  }

  const result = await exportGitArchive(branch, outputDir)
  return {
    statusCode: 200,
    success: true,
    ref: result.ref
  }
}

/**
 * Download the source folder using git.
 * @param {string} outputDir
 * @param {string} branch
 * @returns Promise<[{}]>
 */
async function downloadSourceFolderGit (outputDir, branch) {
  return downloadSourceFolder(outputDir, null, branch)
}

/**
 * An asynchronous version of https.get, with encoding set to utf8.
 * The Promise resolves with an object containing the status code and the
 * response body.
 *
 * @param {object|string} options Can either be an https request options object,
 * or an url string.
 */
function get (options) {
  return githubRequest(options)
}

/**
 * Gives a list of all the source files in the given branch in the repository.
 * The Promise resolves with a list of objects containing information on each
 * source file.
 *
 * @param {string} branch The name of the branch the files are located in.
 */
async function getDownloadFiles (branch) {
  const promises = REQUIRED_GIT_PATHS.map(folder => getFilesInFolder(folder, branch))

  const folders = await Promise.all(promises)
  const files = [].concat.apply([], folders)

  const extensions = ['ts', 'js', 'css', 'scss', 'json', 'mjs']

  const isValidFile = ({ path, size }) =>
    (extensions.some(ext => path.endsWith(`.${ext}`))) && size > 0
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
async function getFilesInFolder (path, branch) {
  const resolvedRef = await resolveGitRef(branch)
  if (!resolvedRef) {
    return []
  }

  const output = await execGit(['ls-tree', '-r', '-l', resolvedRef, path], {
    cwd: GIT_REPO_DIR
  }).catch(() => '')

  if (!output) {
    return []
  }

  return output.split('\n').filter(Boolean).map(line => {
    const [meta, filePath] = line.split('\t')
    const parts = meta.split(' ')
    const size = Number(parts[3])
    return {
      path: filePath,
      size: Number.isFinite(size) ? size : 0,
      type: parts[1]
    }
  })
}

/**
 * Check if a given URL responds with a status 200.
 * The Promise resolves with true if the URL responds with status 200, otherwise
 * false.
 *
 * @param  {string} url The URL to check if exists.
 */
async function urlExists (url) {
  const parsed = parseGitRawUrl(url)
  if (!parsed) {
    return false
  }

  return pathExistsInRepo(parsed.ref, parsed.filePath)
}

/**
 * Gets branch info from git.
 * @param {string} branch
 * The branch name
 *
 * @returns {Promise<({}|false)>}
 * The branch info object, or false if not found
 */
async function getBranchInfo (branch) {
  return getWithCache(branchInfoCache, branch, async () => {
    const sha = await resolveGitRef(branch)
    if (!sha) {
      return false
    }
    return { commit: { sha } }
  })
}

/**
 * Gets commit info from git.
 * @param {string} commit
 * The commit sha, long or short
 *
 * @returns {Promise<({}|false)>}
 * The commit info object, or false if not found
 */
async function getCommitInfo (commit) {
  return getWithCache(commitInfoCache, commit, async () => {
    const sha = await resolveGitRef(commit)
    if (!sha) {
      return false
    }
    return { sha }
  })
}

function setGitHubRequest (fn) {
  githubRequest = typeof fn === 'function' ? fn : disabledGitHubRequest
}

function clearGitHubCache () {
  branchInfoCache.clear()
  commitInfoCache.clear()
  defaultBranchCache = undefined
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
  ensureGitRepo,
  syncMaster,
  resolveGitRef,
  pathExistsInRepo,
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
