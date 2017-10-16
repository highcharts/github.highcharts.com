/**
 * Utility functions to validate POST from a Github webhook.
 * @author Jon Arild Nygard
 * @todo Add license
 */
'use strict'
const crypto = require('crypto')
const {
  isObject,
  isString
} = require('./utilities.js')

/**
 * sha1 - Create a sha1 string, uses a secret string to cryptate the data.
 *
 * @param {string} secret The secret to cryptate with.
 * @param {string} data The data to cryptate.
 * @return {string|false} Returns a sha1 string. Returns false if invalid input
 *     parameters.
 */
const sha1 = (secret, data) => {
  let result = false
  if (isString(secret) && isString(data)) {
    result = crypto.createHmac('sha1', secret)
      .update(data, 'utf8')
      .digest('hex')
  }
  return result
}

/**
 * validSignature - Checks if the signature is valid. The signature should match
 * the resulting sha1 created from the body and secret.
 *
 * @param {string} signature The signature to validate.
 * @param {string} body The received content of the body.
 * @param {string} secret The secret token used to cryptate the body.
 * @return {boolean} Returns true if signature is valid. Returns false if
 * invalid signature, or invalid input parameters.
 */
const validSignature = (signature, body, secret) => {
  let result = false
  if (isString(signature) && isString(body) && isString(secret)) {
    const sha = sha1(secret, body)
    if (isString(sha)) {
      const hash = 'sha1=' + sha
      result = signature === hash
    }
  }
  return result
}

/**
 * validateWebHook - Checks if a POST from a Github is safe and has valid data.
 *
 * @param {object} request An ExpressJS request object.
 * @param {object} request.body An object representation of the request body.
 * @param {object} request.headers An object representation of the request headers.
 * @param {string} request.rawBody A string representation of the request body.
 * @param {string} secureToken The secure token used in cryptating the body.
 * @return {object} Returns an object containing the properties {boolean} valid,
 * and {string} message.
 */
const validateWebHook = (request, secureToken) => {
  let valid = false
  let message = ''
  if (isObject(request) && isString(secureToken)) {
    const body = request.body
    const payload = request.rawBody
    if (isObject(body) && isString(payload)) {
      const signature = request.headers['x-hub-signature']
      if (
        isString(signature) &&
        validSignature(signature, payload, secureToken)
      ) {
        if (isString(body.ref)) {
          valid = true
        } else {
          message = 'Missing Git ref'
        }
      } else {
        message = 'Invalid signature'
      }
    } else {
      message = 'Missing payload'
    }
  } else {
    message = 'Invalid input parameters'
  }
  return {
    valid: valid,
    message: message
  }
}

module.exports = {
  sha1,
  validateWebHook,
  validSignature
}
