/**
 * Utility functions to validate a POST from a GitHub webhook.
 * @author Jon Arild Nygard
 * @todo Add license
 */
'use strict'

// Import dependencies, sorted by path name.
const { isObject, isString } = require('./utilities.js')
const crypto = require('crypto')

/**
 * Creates a sha1 string, uses a secret string to cryptate the data. Returns a
 * sha1 string, or false if invalid input parameters.
 *
 * @param {string} secret The secret to cryptate with.
 * @param {string} data The data to cryptate.
 */
function sha1 (secret, data) {
  let result = false
  if (isString(secret) && isString(data)) {
    result = crypto.createHmac('sha1', secret)
      .update(data, 'utf8')
      .digest('hex')
  }
  return result
}

/**
 * Checks if a POST is from a valid Github webhook, that it is secure and has
 * valid data. Returns an object containing the properties {boolean} valid,
 * and {string} message.
 *
 * @param {Request} [request] An ExpressJS request object.
 * @param {object} [request.body] An object representation of the request body.
 * @param {object} [request.headers] An object representation of the request
 * headers.
 * @param {string} [request.rawBody] A string representation of the request
 * body.
 * @param {string} [secureToken] The secure token used in cryptating the body.
 */
function validateWebHook (request, secureToken) {
  return !(isObject(request) && isString(secureToken))
    ? { valid: false, message: 'Invalid input parameters' }
    : !(isObject(request.body) && isString(request.rawBody))
      ? { valid: false, message: 'Missing payload' }
      : !(
        isString(request.headers['x-hub-signature']) &&
        validSignature(
          request.headers['x-hub-signature'],
          request.rawBody,
          secureToken
        ))
        ? { valid: false, message: 'Invalid signature' }
        : isString(request.body.ref)
          ? { valid: true, message: '' }
          : { valid: false, message: 'Missing Git ref' }
}

/**
 * validSignature - Checks if the signature is valid. The signature should match
 * the resulting sha1 created from the body and secret. Returns true if
 * signature is valid, false if invalid signature, or invalid input parameters.
 *
 * @param {string} signature The signature to validate.
 * @param {string} body The received content of the body.
 * @param {string} secret The secret token used to cryptate the body.
 */
function validSignature (signature, body, secret) {
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

// Export webhook functionality
module.exports = {
  sha1,
  validateWebHook,
  validSignature
}
