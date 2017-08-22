/**
 * Contains all procedures related to requests and downloading of files.
 * @author Jon Arild Nygard
 * @todo Add license
 */
'use strict'
const https = require('https')
/**
 * Check if a url returns 200.
 * @param  {string} url Url to check
 * @return {Promise} Returns a Promise which resolves when the a response from the url is given. Returns true if statusCode is 200, otherwise false.
 */
const urlExists = url => new Promise(resolve => {
  https.get(url, response => resolve(response.statusCode === 200))
})

/**
 * Download a single file.
 * @param  {string} base   Base url
 * @param  {string} path   Location of file. Url is base + '/' + path
 * @param  {string} output Where to output the file
 * @return {Promise} Returns a promise when resolved contains the status code and path to the file.
 */
const downloadFile = (base, path, output) => {
  const U = require('./utilities.js')
  return new Promise((resolve) => {
    const fs = require('fs')
    let url = base + '/' + path
    let outputPath = output + path
    U.createDirectory(U.folder(outputPath))
    https.get(url, response => {
      if (response.statusCode === 200) {
        let file = fs.createWriteStream(outputPath)
        response.pipe(file)
        file.on('finish', () => {
          resolve({
            status: response.statusCode,
            path: outputPath
          })
        })
      } else {
        resolve({
          status: response.statusCode
        })
      }
    })
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
  return new Promise((resolve) => {
    let promises = filePaths.map(path => downloadFile(base, path, output))
    Promise.all(promises).then((values) => resolve(values))
  })
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

const getFilesInFolder = (path, branch) => new Promise((resolve, reject) => {
  const token = require('../config.json').token
  const host = 'api.github.com'
  const url = `/repos/highcharts/highcharts/contents/${path}?ref=${branch}&access_token=${token}`
  get(host, url)
        .then(result => {
          if (result.status === 200) {
            let contents = JSON.parse(result.body)
            let promises = contents.map(obj => new Promise((resolve) => {
              let name = url + '/' + obj.name
              let result
              if (obj.type === 'dir') {
                result = getFilesInFolder(name, branch)
              } else {
                result = [{
                  download: obj.download_url,
                  path: name,
                  size: obj.size,
                  type: obj.type
                }]
              }
              resolve(result)
            }))
            Promise.all(promises)
                    .then(arr => {
                      const files = arr.reduce((arr1, arr2) => {
                        return arr1.concat(arr2)
                      }, [])
                      resolve(files)
                    })
                    .catch(reject)
          } else {
            reject(result.body)
          }
        })
        .catch(reject)
})

const getDownloadFiles = (branch) => new Promise((resolve, reject) => {
  const promises = ['css', 'js'].map(folder => getFilesInFolder(folder, branch))
  Promise.all(promises)
        .then(folders => {
          const files = folders[0].concat(folders[1])
          const result = files.filter(file => (file.path.endsWith('.js') || file.path.endsWith('.scss')))
                .filter(file => file.size > 0)
                .map(file => file.path)
          resolve(result)
        })
        .catch(reject)
})

/**
 * Download all the files in the js folder of the repository
 * @param  {string} output Where to output all the files
 * @param  {string} url Url to the repository in raw format
 * @return {Promise} Returns a promise which is resolved when all files are downloaded
 */
const downloadJSFolder = (output, repositoryURL, branch) => {
  const url = repositoryURL + branch
  return getDownloadFiles(branch)
        .then(files => downloadFiles(url, files, output))
}

/**
 * Download all the files in the assembler folder of the repository
 * @param  {string} output Where to output all the files
 * @param  {string} url Url to the repository in raw format
 * @return {Promise} Returns a promise which is resolved when all files are downloaded
 */
const downloadAssembler = (output, url) => {
  return downloadFiles(url, [
    'assembler/build.js',
    'assembler/dependencies.js',
    'assembler/process.js',
    'assembler/utilities.js'
  ], output)
}

module.exports = {
  downloadAssembler,
  downloadFile,
  downloadFiles,
  downloadJSFolder,
  getDownloadFiles,
  urlExists
}
