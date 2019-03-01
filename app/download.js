/**
 * Contains all procedures related to requests and downloading of files.
 * @author Jon Arild Nygard
 * @todo Add license
 */
'use strict'
const https = require('https')
const {
  dirname,
  join,
  sep
} = require('path')
const {
  createDirectory,
  writeFilePromise
} = require('./filesystem.js')
const {
  createWriteStream
} = require('fs')
const token = require('../config.json').token

/**
 * Check if a url returns 200.
 * @param  {string} url Url to check
 * @return {Promise} Returns a Promise which resolves when the a response from the url is given. Returns true if statusCode is 200, otherwise false.
 */
const urlExists = url => new Promise(resolve => {
  https.get(url, response => resolve(response.statusCode === 200))
})

/**
 * A promise version of https.get. Will resolve with a response object if the
 * request was successful, or reject if the request errored.
 * @param {object|string} options Can either be an https request options object,
 * or an url string.
 * @returns {Promise} Returns a promise which resolves with the request
 * response.
 */
const httpsGetPromise = (options) => new Promise((resolve, reject) => {
  const request = https.get(options, response => {
    const body = []
    response.on('data', (d) => {
      body.push(d)
    })
    response.on('end', () => resolve({
      statusCode: response.statusCode,
      body: body.join('')
    }))
  })
  request.on('error', (e) => {
    reject(e)
  })
  request.end()
})

/**
 * Download a single file.
 * @param  {string} base   Base url
 * @param  {string} path   Location of file. Url is base + '/' + path
 * @param  {string} output Where to output the file
 * @return {Promise} Returns a promise when resolved contains the status code and path to the file.
 */
const downloadFile = (base, path, output) => {
  return new Promise((resolve, reject) => {
    let url = base + '/' + path
    let outputPath = output + path
    createDirectory(dirname(outputPath))
    https.get(url, response => {
      if (response.statusCode === 200) {
        let file = createWriteStream(outputPath)
        file.on('error', (err) => {
          file.end()
          reject(err)
        })
        file.on('finish', () => {
          resolve({
            status: response.statusCode,
            path: outputPath
          })
        })
        response.pipe(file)
      } else {
        resolve({
          status: response.statusCode
        })
      }
    })
  })
}

const downloadFilePromise = (url, outputPath) => {
  return httpsGetPromise(url)
    .then(({ body, statusCode }) => {
      let result = {
        outputPath,
        statusCode,
        success: false,
        url
      }
      let promise
      if (statusCode === 200) {
        createDirectory(dirname(outputPath))
        promise = writeFilePromise(outputPath, body)
          .then(() => {
            result.success = true
            return result
          })
      } else {
        promise = Promise.resolve(result)
      }
      return promise
    })
}

/**
 * Downloads a series of files using the same base url
 * @param  {string} base The base url
 * @param  {[string]} filePaths Array of filepaths.
 * @param  {string} output Where to output the file
 * @return {Promise} Returns a promise which is resolved when all files are downloaded
 */
const downloadFiles = (base, filePaths, output) => {
  const promises = filePaths
    .map(path => downloadFilePromise(join(base, path), join(output, path)))
  return Promise.all(promises)
}

const get = (host, path) => new Promise((resolve, reject) => {
  const agent = 'github.highcharts.com'
  https.get({
    hostname: host,
    path: path,
    headers: {
      'user-agent': agent
    }
  }, response => {
    let body = ''
    response.setEncoding('utf8')
    response.on('data', data => (body += data))
    response.on('end', () => {
      resolve({
        status: response.statusCode,
        body: body
      })
    })
    response.on('error', e => reject(e))
  })
})

const getFilesInFolder = (path, branch) => {
  const host = 'api.github.com'
  const url = `/repos/highcharts/highcharts/contents/${path}?ref=${branch}&access_token=${token}`
  return get(host, url)
    .then(result => {
      const {
        status,
        body
      } = result
      return (
        (status === 200)
          ? JSON.parse(body)
          : Promise.reject(new Error(body))
      )
    })
    .then(contents => {
      const promises = contents.map(obj => {
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
      return Promise.all(promises)
    })
    .then(arr => arr.reduce((arr1, arr2) => arr1.concat(arr2), []))
}

const getDownloadFiles = (branch) => {
  const promises = ['css', 'js'].map(folder => getFilesInFolder(folder, branch))
  return Promise.all(promises)
    .then(folders => {
      const files = folders[0].concat(folders[1])
      const result = files.filter(file => (file.path.endsWith('.js') || file.path.endsWith('.scss')))
        .filter(file => file.size > 0)
        .map(file => file.path)
      return result
    })
}

/**
 * Download all the files in the js folder of the repository
 * @param  {string} output Where to output all the files
 * @param  {string} url Url to the repository in raw format
 * @return {Promise} Returns a promise which is resolved when all files are downloaded
 */
const downloadJSFolder = (output, repositoryURL, branch) => {
  const url = join(repositoryURL, branch).split(sep).join('/')
  return getDownloadFiles(branch)
    .then(files => downloadFiles(url, files, output))
}

module.exports = {
  downloadFile,
  downloadFilePromise,
  downloadFiles,
  downloadJSFolder,
  getDownloadFiles,
  httpsGetPromise,
  urlExists
}
