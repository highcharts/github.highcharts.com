/**
 * Utility functions for type checking, and etc.
 * @author Jon Arild Nygard
 * @todo Add license
 */
'use strict'

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
 * @todo remove redundant function
 */
function padStart (str, length = 0, char) {
  return isString(str) ? str.padStart(length, char) : false
}

// Export utility functions
module.exports = {
  isArray,
  isBool,
  isDate,
  isJSON,
  isNull,
  isObject,
  isString,
  isUndefined,
  padStart
}
