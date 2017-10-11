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

/**
 * @todo Add type checking
 * @todo Check length of char
 * @todo Add tests
 */
const padStart = (str, length, char) => {
  const rep = length - str.length
  let padding = ''
  if (rep > 0) {
    padding = char.repeat(rep)
  }
  return padding + str
}

module.exports = {
  isArray,
  isBool,
  isDate,
  isObject,
  isString,
  isUndefined,
  padStart
}
