/**
 * Basic utility functions for type checking.
 * @author Jon Arild Nygard
 * @todo Add license
 */
const isUndefined = x => (typeof x === 'undefined')

const isString = string => (typeof string === 'string')

const isBool = x => (typeof x === 'boolean')

const isArray = x => Array.isArray(x)

const isNull = x => x === null

const isObject = x => ((typeof x === 'object') && !isArray(x) && !isNull(x))

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
  let result = false
  if (isString(str)) {
    const paddingLength = length - str.length
    let padding = ''
    if (paddingLength > 0) {
      let c = isString(char) ? char : ' '
      padding = c.repeat(paddingLength).slice(0, paddingLength)
    }
    result = padding + str
  }
  return result
}

module.exports = {
  isArray,
  isBool,
  isDate,
  isNull,
  isObject,
  isString,
  isUndefined,
  padStart
}
