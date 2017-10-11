/**
 * Basic utility functions for type checking.
 * @author Jon Arild Nygard
 * @todo Add license
 */
const isUndefined = x => (typeof x === 'undefined')

const isString = string => (typeof string === 'string')

const isBool = x => (typeof x === 'boolean')

const isArray = x => Array.isArray(x)

const isObject = x => ((typeof x === 'object') && !isArray(x))

/**
 * isDate - Checks wether the input is a valid Date object.
 * @param {Date} x Item to test.
 * @return {bool} true if valid, false if not.
 */
const isDate = (x) => (
  Object.prototype.toString.call(x) === '[object Date]' &&
  !isNaN(x.getDay())
)

module.exports = {
  isArray,
  isBool,
  isDate,
  isObject,
  isString,
  isUndefined
}
