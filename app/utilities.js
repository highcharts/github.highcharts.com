/**
 * Utility functions for type checking, and etc.
 * @author Jon Arild Nygard
 * @todo Add license
 */
'use strict'

const childProcess = require('child_process')
const { join } = require('path')
const fs = require('fs').promises
const util = require('util')

// Import dependencies, sorted by path.
const config = require('../config.json')

// Constants
const INFORMATION_LEVEL = typeof config.informationLevel === 'number'
  ? config.informationLevel : 2

/**
 * Format a date as YYYY-MM-DDTHH-MM-SS. Returns a string with date formatted
 * as YYYY-MM-DDTHH-MM-SS, or false if input is not a valid date.
 *
 * @param {Date} date A Date object to be formatted.
 */
function formatDate (date) {
  let result = false
  if (isDate(date)) {
    const day = [
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate()
    ].map((x, i) => padStart(('' + x), (i > 0 ? 2 : 4), '0')).join('-')
    const time = 'T' + [
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds()
    ].map(x => padStart(('' + x), 2, '0')).join('-')
    result = day + time
  }
  return result
}

/**
 * Check if the input value is of type array. Returns true if type is
 * array, otherwise false.
 *
 * @param {*} x The value to check if is array.
 */
function isArray (x) {
  return Array.isArray(x)
}

/**
 * Check if the input value is of type boolean. Returns true if type is
 * boolean, otherwise false.
 *
 * @param {*} x The value to check if is boolean.
 */
function isBool (x) {
  return typeof x === 'boolean'
}

/**
 * Check if the input value is a valid Date object. Returns true if valid,
 * otherwise false.
 * @param {*} x The value to check if is a valid Date object.
 */
function isDate (x) {
  return Object.prototype.toString.call(x) === '[object Date]' &&
    !isNaN(x.getDay())
}

/**
 * Check if the input value is valid JSON. Returns true if valid,
 * otherwise false.
 * @param {*} x The value to check if is valid JSON.
 */
function isJSON (x) {
  let result = false
  if (isString(x)) {
    try {
      JSON.parse(x)
      result = true
    } catch (e) {}
  }
  return result
}

/**
 * Check if the input value is of type null. Returns true if type is
 * null, otherwise false.
 *
 * @param {*} x The value to check if is null.
 */
function isNull (x) {
  return x === null
}

/**
 * Check if the input value is of type object. Returns true if type is
 * object, otherwise false.
 *
 * @param {*} x The value to check if is object.
 */
function isObject (x) {
  return (typeof x === 'object') && !isArray(x) && !isNull(x)
}

/**
 * Check if the input value is of type string. Returns true if type is
 * string, otherwise false.
 *
 * @param {*} x The value to check if is string.
 */
function isString (x) {
  return typeof x === 'string'
}

/**
 * Check if the input value is of type undefined. Returns true if type is
 * undefinded, otherwise false.
 *
 * @param {*} x The value to check if is undefined.
 */
function isUndefined (x) {
  return typeof x === 'undefined'
}

/**
 * Output a message, depending on its severity, and the requested level of
 * information.
 *
 * @param {number} severity The severity of the message. Use 0 for info,
 * 1 for warning, 2 for errors.
 * @param {string} text The message to output.
 */
function log (severity, text) {
  if (severity >= INFORMATION_LEVEL) {
    console.log(text) // eslint-disable-line no-console
  }
}

/**
 * @todo remove redundant function
 */
function padStart (str, length = 0, char) {
  return isString(str) ? str.padStart(length, char) : false
}

/**
 * Compiles TypeScript in a downloaded folder residing in tmp/.
 * Can be long running.
 * @param {String} branch to specific commit, tag or branch
 */
function compileTypeScript (branch) {
  log(0, `Compiling TypeScript for downloaded folder ${branch}..`)
  return util.promisify(childProcess.exec)(`cd ${join(__dirname, '../tmp')}/${branch}/ts/ && npx tsc --skipLibCheck`)
}

async function updateBranchAccess (branchPath) {
  const { stat, writeFile, readdir } = fs
  const filePath = join(branchPath, 'info.json')

  const jsonString = JSON.stringify({ last_access: new Date() })

  if (await stat(branchPath)) {
    // create file if not existant
    const isFile = (await readdir(branchPath)).includes('info.json')
    if (!isFile) {
      return writeFile(filePath, jsonString)
    }

    // Only update if the date has changed
    const data = require(filePath)
    const splitDate = (date) => date.toISOString().split('T')[0]

    if (splitDate(new Date(data.last_access)) !== splitDate(new Date())) {
      return writeFile(filePath, jsonString)
    }
  }

  return Promise.resolve()
}

async function getGlobalsLocation (filePath) {
  const content = await fs.readFile(filePath, 'utf-8')

  return content.match(/\/.*\/Globals.js.*$/m)[0]
}

// Export utility functions
module.exports = {
  formatDate,
  isArray,
  isBool,
  isDate,
  isJSON,
  isNull,
  isObject,
  isString,
  isUndefined,
  log,
  padStart,
  compileTypeScript,
  getGlobalsLocation,
  updateBranchAccess
}
