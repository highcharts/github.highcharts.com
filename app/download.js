/**
 * Contains all procedures related to requests and downloading of files.
 * @author Jon Arild Nygard
 * @todo Add license
 */
'use strict'

// Import dependencies, sorted by path.
const { token } = require('../config.json')
const { writeFile } = require('./filesystem.js')
const { log } = require('./utilities.js')
const { get: httpsGet } = require('https')
const { join } = require('path')
const authToken = {'Authorization': `token ${token}`}

/**
 * Downloads the content of a url and writes it to the given output path.
 * The Promise is resolved with an object containing information of the result
 * of the process.
 *
 * @param {string} url The URL location to the content to download.
 * @param {string} outputPath The path to output the content at the URL.
 */
async function downloadFile (url, outputPath) {
  const { body, statusCode } = await get(url)
  const result = {
    outputPath,
    statusCode,
    success: false,
    url
  }

  if (statusCode === 200) {
    await writeFile(outputPath, body)
    result.success = true
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
function downloadFiles (baseURL, subpaths, outputDir) {
  const promises = subpaths
    .map(path => downloadFile(`${baseURL}/${path}`, join(outputDir, path)))
  return Promise.all(promises)
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
  const url = `${repositoryURL}${branch}`
  const files = await getDownloadFiles(branch)
  const responses = await downloadFiles(url, files, outputDir)
  const errors = responses
    .filter(({ statusCode }) => statusCode !== 200)
    .map(({ url, statusCode }) => `${statusCode}: ${url}`)

  // Log possible errors
  if (errors.length) {
    log(2, `Some files did not download in branch "${branch}"\n${
      errors.join('\n')
    }`)
  }
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
  return new Promise((resolve, reject) => {
    const request = httpsGet(options, response => {
      const body = []
      response.setEncoding('utf8')
      response.on('data', (data) => { body.push(data) })
      response.on('end', () =>
        resolve({ statusCode: response.statusCode, body: body.join('') })
      )
    })
    request.on('error', reject)
    request.end()
  })
}

/**
 * Gives a list of all the source files in the given branch in the repository.
 * The Promise resolves with a list of objects containing information on each
 * source file.
 *
 * @param {string} branch The name of the branch the files are located in.
 */
async function getDownloadFiles (branch) {
  const promises = ['css', 'ts', 'js'].map(folder => getFilesInFolder(folder, branch))
  const folders = await Promise.all(promises)
  const files = [].concat.apply([], folders)
  const isValidFile = ({ path, size }) =>
    (path.endsWith('.js') || path.endsWith('.ts') || path.endsWith('.scss') || path.endsWith('.json')) && size > 0
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
  const { body, statusCode } = await get({
    hostname: 'api.github.com',
    path: `/repos/highcharts/highcharts/contents/${path}?ref=${branch}`,
    headers: {
      'user-agent': 'github.highcharts.com',
      ...authToken
    }
  })

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
async function urlExists (url) {
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
  const { body, statusCode } = await get({
    hostname: 'api.github.com',
    path: `/repos/highcharts/highcharts/branches/${branch}`,
    headers: {
      'user-agent': 'github.highcharts.com',
      ...authToken
    }
  })
  if (statusCode === 200) {
    return JSON.parse(body)
  }
  return false
}

// Export download functions
module.exports = {
  downloadFile,
  downloadFiles,
  downloadSourceFolder,
  getDownloadFiles,
  httpsGetPromise: get,
  urlExists,
  getBranchInfo
}
