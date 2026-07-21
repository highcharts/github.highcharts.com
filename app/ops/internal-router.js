'use strict'

const { randomUUID } = require('node:crypto')
const express = require('express')
const { OpsHttpError, asyncRoute, errorBody, readStrictJSON, requireBearer, requireJSONContentType } = require('./http')
const { deriveCacheOutcome, validateCacheOperationRequest, validateCacheOperationResponse, validateServiceSnapshot } = require('./schemas')

const MAX_REQUEST_BYTES = 64 * 1024
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_MUTATION_RESPONSE_BYTES = 64 * 1024
const CORRELATION_ID = /^[\x21-\x7e]{1,64}$/

function createInternalOpsRouter ({ token, service, snapshot, cache, now = Date.now } = {}) {
  if (typeof token !== 'string' || !token) throw new TypeError('Internal service token is required')
  if (!['downloader', 'builder'].includes(service)) throw new TypeError('Internal operations service is invalid')
  if (typeof snapshot !== 'function') throw new TypeError('Internal snapshot provider is required')
  if (!cache || typeof cache.execute !== 'function') throw new TypeError('Internal cache manager is required')

  const router = express.Router()

  router.use((request, response, next) => {
    response.set('Cache-Control', 'no-store')
    response.set('X-Content-Type-Options', 'nosniff')
    request.correlationId = correlationId(request)
    response.set('X-Correlation-ID', request.correlationId)
    try {
      requireBearer(request, token)
      next()
    } catch (error) {
      sendError(response, error, request.correlationId)
    }
  })

  router.get('/v1/ops/snapshot', asyncRoute(async (request, response) => {
    const value = await snapshot(request.correlationId)
    const result = validateGenerated(() => validateServiceSnapshot(value, service))
    sendJSON(response, result, MAX_RESPONSE_BYTES)
  }))

  router.post('/v1/ops/cache-operations', asyncRoute(async (request, response) => {
    requireJSONContentType(request)
    const command = validateCacheOperationRequest(await readStrictJSON(request, MAX_REQUEST_BYTES))
    if (command.targets.length !== 1 || command.targets[0] !== service) {
      throw new OpsHttpError(400, 'INVALID_REQUEST', 'Request body is invalid', ['targets'])
    }

    const startedAt = new Date(now()).toISOString()
    const target = await cache.execute(command.operation, command.commit)
    const result = validateGenerated(() => validateCacheOperationResponse({
      correlationId: request.correlationId,
      operation: command.operation,
      startedAt,
      completedAt: new Date(now()).toISOString(),
      outcome: deriveCacheOutcome([target]),
      targets: [target]
    }))
    sendJSON(response, result, MAX_MUTATION_RESPONSE_BYTES)
  }))

  router.use((error, request, response, next) => {
    if (response.headersSent) return next(error)
    sendError(response, error, request.correlationId)
  })
  return router
}

function correlationId (request) {
  const value = request.get('x-correlation-id')
  return CORRELATION_ID.test(value || '') ? value : randomUUID()
}

function sendJSON (response, value, maximum) {
  const body = Buffer.from(JSON.stringify(value))
  if (body.length > maximum) throw new Error('Internal operations response exceeded its limit')
  response.status(200).type('application/json').send(body)
}

function validateGenerated (validator) {
  try {
    return validator()
  } catch (error) {
    throw new Error('Internal operations provider returned invalid data')
  }
}

function sendError (response, error, correlationId) {
  const result = errorBody(error, correlationId)
  response.status(result.status).json(result.body)
}

module.exports = {
  MAX_MUTATION_RESPONSE_BYTES,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  createInternalOpsRouter
}
