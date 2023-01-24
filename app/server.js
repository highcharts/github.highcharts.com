// @
/**
 * Server application.
 * Fires up a server using ExpressJS, and registers routers, and starts listening to a port.
 * All processes related to startup belongs in this script.
 * @author Jon Arild Nygard
 * @todo Add license
 */
'use strict'

// Import dependencies, sorted by path name.
const config = require('../config.json')
const {
  bodyJSONParser,
  clientErrorHandler,
  logErrors,
  setConnectionAborted
} = require('./middleware.js')
const router = require('./router.js')
const { formatDate, log, compileTypeScript, compileTypeScriptProject } = require('./utilities.js')
const express = require('express')
const { cleanUp, shouldClean } = require('./filesystem')

// Constants
const APP = express()
const PORT = process.env.PORT || config.port || 80
const DATE = formatDate(new Date())

const state = {
  typescriptJobs: {},
  downloads: {},
  assembles: {}
}

/**
 * Adds the compilation of the branch to the job registry
 * Returns the promise
 * @param {string} branch
 * @param {string} file
 * @returns {Promise}
 */
function addTypescriptJob (branch, file, buildProject = false) {
  // Return an existing job if it is found
  const existingJob = getTypescriptJob(branch, file)
  if (existingJob) return existingJob

  const id = branch + (buildProject ? 'project' : file)
  // Check if there is a job going on the file
  if (!state.typescriptJobs[id]) {
    const job = state.typescriptJobs[id] = buildProject
      ? compileTypeScriptProject(branch).finally(() => {
          // Project jobs remove themselves
          removeTypescriptJob(branch, 'project')
        })
      : compileTypeScript(branch, file)

    return job
  }
}

/**
 * Removes a job from the registry
 * @param {*} branch
 * @param {string} file
 */
function removeTypescriptJob (branch, file) {
  const id = branch + file
  if (state.typescriptJobs[id]) delete state.typescriptJobs[id]
}

/**
 * Returns a job from the registry
 * @param {*} branch
 */
function getTypescriptJob (branch, file) {
  // Return the project job if it exists
  if (state.typescriptJobs[branch + 'project']) {
    return state.typescriptJobs[branch + 'project']
  }

  const id = branch + file
  return state.typescriptJobs[id]
}

/**
 * Sets a download job in the registry
 * or returns an existing job
 * @param {string} branch
 * @returns {Promise<any> | undefined}
 */
function addDownloadJob (branch, promise) {
  if (!state.downloads[branch]) {
    const job = state.downloads[branch] = promise
    return job
  }
}

/**
 * Get a download job from the registry
 * @param {string} branch
 * @returns {Promise<any> | undefined}
 */
function getDownloadJob (branch) {
  return state.downloads[branch]
}

function removeDownloadJob (branch) {
  setTimeout(() => {
    if (state.downloads[branch]) delete state.downloads[branch]
  }, 5000)
}

/**
 * Sets a download job in the registry
 * or returns an existing job
 * @param {string} branch
 * @returns {Promise<any> | undefined}
 */
function addAssemblyJob (id, promise) {
  if (!state.downloads[id]) {
    const job = state.assembles[id] = promise
    return job
  }
}

/**
 * Get a download job from the registry
 * @param {string} branch
 * @returns {Promise<any> | undefined}
 */
function getAssemblyJob (id) {
  return state.assembles[id]
}

function removeAssemblyJob (id) {
  setTimeout(() => {
    if (state.assembles[id]) delete state.assembles[id]
  }, 2500)
}

// Output status information
log(2, `
Starting server
Port: ${PORT}
Date: ${DATE}
`)

/**
 * Register middleware for ExpressJS application
 *
 * Important! The sequence of registering the middleware is crucial when it
 * comes to how it executes. First come first served.
 * 1. Listen for aborted connections
 * 2. Parse request body.
 * 3. Do application routing
 * 4. If an error occurs above, the clientErrorHandler will give the client
 *    a proper response, and pass the error to the next middleware.
 * 5. If an error occurs above the logErrors will log it to the console, with
 *    additional information. It will not pass the error to the next middleware.
 */
APP.use(setConnectionAborted)
APP.use(bodyJSONParser)
APP.use(router)
APP.use(clientErrorHandler)
APP.use(logErrors)

/**
 * Start the server
 */
APP.listen(PORT)

// Clean up the tmp folder every now and then
setInterval(async () => {
  // Clean only after a certain amount of branches and when there are no jobs running
  if ((await shouldClean()) && Object.keys(state.typescriptJobs).length === 0) {
    log(0, 'Cleaning up...')
    await cleanUp()
  }
}, config.cleanInterval || 2 * 60 * 1000)

module.exports = {
  default: APP,
  getTypescriptJob,
  addTypescriptJob,
  removeTypescriptJob,
  addDownloadJob,
  getDownloadJob,
  removeDownloadJob,
  getAssemblyJob,
  addAssemblyJob,
  removeAssemblyJob,
  state
}
