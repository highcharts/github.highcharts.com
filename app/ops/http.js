'use strict'

const { createHash, randomUUID, timingSafeEqual } = require('node:crypto')

const MAX_BODY_BYTES = 4 * 1024
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"
const SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY'
})
const CORRELATION_ID = /^[\x21-\x7e]{1,64}$/

class OpsHttpError extends Error {
  constructor (status, code, message, fields) {
    super(message)
    this.name = 'OpsHttpError'
    this.status = status
    this.code = code
    this.fields = fields
  }
}

function strictJSON (input, maximum = MAX_BODY_BYTES) {
  const body = Buffer.isBuffer(input) ? input : Buffer.from(input || '')
  if (body.length > maximum) throw new OpsHttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large')

  let source
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch (error) {
    throw invalidJSON()
  }

  let position = 0
  const whitespace = () => { while (' \t\n\r'.includes(source[position]) && position < source.length) position++ }
  const fail = () => { throw invalidJSON() }
  const string = () => {
    const start = position
    if (source[position++] !== '"') fail()
    while (position < source.length) {
      const character = source[position++]
      if (character === '"') {
        try { return JSON.parse(source.slice(start, position)) } catch (error) { fail() }
      }
      if (character < ' ' || (character === '\\' && !/^(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/.test(source.slice(position)))) fail()
      if (character === '\\') position += source[position] === 'u' ? 5 : 1
    }
    fail()
  }
  const value = () => {
    whitespace()
    if (source[position] === '"') return string()
    if (source[position] === '{') return object()
    if (source[position] === '[') return array()
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]]) {
      if (source.startsWith(literal, position)) {
        position += literal.length
        return result
      }
    }
    const match = source.slice(position).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)
    if (!match) fail()
    position += match[0].length
    const number = Number(match[0])
    if (!Number.isFinite(number)) fail()
    return number
  }
  const object = () => {
    position++
    whitespace()
    const result = Object.create(null)
    const keys = new Set()
    if (source[position] === '}') { position++; return result }
    while (position < source.length) {
      if (source[position] !== '"') fail()
      const key = string()
      if (keys.has(key)) throw new OpsHttpError(400, 'INVALID_JSON', 'Request body is invalid')
      keys.add(key)
      whitespace()
      if (source[position++] !== ':') fail()
      result[key] = value()
      whitespace()
      if (source[position] === '}') { position++; return result }
      if (source[position++] !== ',') fail()
      whitespace()
    }
    fail()
  }
  const array = () => {
    position++
    whitespace()
    const result = []
    if (source[position] === ']') { position++; return result }
    while (position < source.length) {
      result.push(value())
      whitespace()
      if (source[position] === ']') { position++; return result }
      if (source[position++] !== ',') fail()
    }
    fail()
  }

  let result
  try {
    result = value()
    whitespace()
  } catch (error) {
    if (error instanceof OpsHttpError) throw error
    throw invalidJSON()
  }
  if (position !== source.length || !result || Array.isArray(result) || typeof result !== 'object') throw invalidJSON()
  return result
}

async function readStrictJSON (request, maximum = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > maximum) throw new OpsHttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large')
    chunks.push(bytes)
  }
  return strictJSON(Buffer.concat(chunks, size), maximum)
}

function invalidJSON () {
  return new OpsHttpError(400, 'INVALID_JSON', 'Request body is invalid')
}

function setSecurityHeaders (response) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value)
}

function header (request, name) {
  const value = request.headers?.[name.toLowerCase()]
  return typeof value === 'string' ? value : undefined
}

function requireOrigin (request, origin) {
  if (header(request, 'origin') !== origin) throw new OpsHttpError(403, 'ORIGIN_REJECTED', 'Request origin was rejected')
}

function requireSameOriginFetch (request, { allowTopLevelNavigation = false } = {}) {
  const site = header(request, 'sec-fetch-site')
  const topLevelNavigation = allowTopLevelNavigation &&
    request.method === 'GET' &&
    header(request, 'sec-fetch-mode') === 'navigate' &&
    header(request, 'sec-fetch-dest') === 'document'
  if (site !== undefined && site !== 'same-origin' && !(site === 'none' && topLevelNavigation)) {
    throw new OpsHttpError(403, 'FETCH_METADATA_REJECTED', 'Request context was rejected')
  }
}

function requireJSONContentType (request) {
  const contentType = header(request, 'content-type')
  if (!contentType || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    throw new OpsHttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json')
  }
}

function timingSafeStringEqual (actual, expected) {
  if (typeof expected !== 'string' || expected.length === 0) {
    throw new Error('Invalid expected credential')
  }
  const validActual = typeof actual === 'string' && actual.length > 0
  const digest = value => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(validActual ? actual : '\0'), digest(expected)) && validActual
}

function requireCSRF (request, expected) {
  if (!timingSafeStringEqual(header(request, 'x-ops-csrf'), expected)) {
    throw new OpsHttpError(403, 'CSRF_REJECTED', 'CSRF validation failed')
  }
}

function requireBearer (request, expected) {
  const authorization = header(request, 'authorization') || ''
  const match = authorization.match(/^Bearer ([^\s]+)$/)
  if (!timingSafeStringEqual(match?.[1], expected)) {
    throw new OpsHttpError(401, 'UNAUTHORIZED', 'Authentication required')
  }
}

function errorBody (error, correlationId = randomUUID()) {
  const safe = error instanceof OpsHttpError
    ? error
    : new OpsHttpError(500, 'INTERNAL_ERROR', 'An internal error occurred')
  const body = { error: { code: safe.code, message: safe.message, correlationId } }
  if (Array.isArray(safe.fields)) {
    const fields = [...new Set(safe.fields.filter(field => typeof field === 'string' && /^[\x20-\x7e]{1,64}$/.test(field)))].slice(0, 16)
    if (fields.length) body.error.details = { fields }
  }
  return { status: safe.status, body }
}

function asyncRoute (handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next)
}

function observedRoute (service, route, details, handler) {
  return asyncRoute(async (request, response, next) => {
    request.correlationId = CORRELATION_ID.test(request.get('x-correlation-id') || '') ? request.get('x-correlation-id') : randomUUID()
    response.set('X-Correlation-ID', request.correlationId)
    service.startRequest?.({ correlationId: request.correlationId, method: request.method, route, ...details(request) })
    let completed = false
    const complete = outcome => {
      if (completed) return
      completed = true
      service.completeRequest?.(request.correlationId, outcome)
    }
    response.once('finish', () => complete({ status: response.statusCode < 400 ? 'succeeded' : 'failed', httpStatus: response.statusCode }))
    response.once('close', () => complete({ status: response.writableEnded ? 'succeeded' : 'aborted', httpStatus: response.statusCode }))
    try {
      await handler(request, response, next)
    } catch (error) {
      complete({ status: error.code === 'QUEUE_FULL' ? 'rejected' : 'failed', httpStatus: error.status || 500, code: error.code || 'INTERNAL_ERROR' })
      throw error
    }
  })
}

module.exports = {
  MAX_BODY_BYTES,
  OpsHttpError,
  SECURITY_HEADERS,
  asyncRoute,
  errorBody,
  observedRoute,
  readStrictJSON,
  requireBearer,
  requireCSRF,
  requireJSONContentType,
  requireOrigin,
  requireSameOriginFetch,
  setSecurityHeaders,
  strictJSON,
  timingSafeStringEqual
}
