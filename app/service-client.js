'use strict'

const { Readable } = require('node:stream')
const { strictJSON } = require('./ops/http')

class ServiceError extends Error {
  constructor (code, message, status, metadata = {}) {
    super(message)
    this.name = code === 'QUEUE_FULL' ? 'QueueFullError' : 'ServiceError'
    this.code = code
    this.status = status
    Object.assign(this, metadata)
  }
}

function createServiceClient (options = {}) {
  const baseURL = (options.baseURL || '').replace(/\/$/, '')
  const token = options.token
  const timeout = Number(options.timeout || 5000)
  const fetchImpl = options.fetch || global.fetch

  async function request (path, requestOptions = {}, retainTimeout = false) {
    const { correlationId, maxRequestBytes, maxResponseBytes, timeoutThroughBody, ...fetchOptions } = requestOptions
    if (correlationId !== undefined && (typeof correlationId !== 'string' || !/^[\x21-\x7e]{1,64}$/.test(correlationId))) {
      throw new TypeError('Invalid correlation ID')
    }
    const body = fetchOptions.body && typeof fetchOptions.body !== 'string'
      ? JSON.stringify(fetchOptions.body)
      : fetchOptions.body
    if (maxRequestBytes !== undefined && Buffer.byteLength(body || '') > maxRequestBytes) {
      throw new ServiceError('REQUEST_TOO_LARGE', 'Service request is too large', 413)
    }
    const controller = new AbortController()
    const externalSignal = fetchOptions.signal
    const abort = () => controller.abort()
    externalSignal?.addEventListener('abort', abort, { once: true })
    if (externalSignal?.aborted) abort()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, fetchOptions.timeout || timeout)
    let retained = false
    const release = () => {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', abort)
    }
    try {
      const response = await fetchImpl(baseURL + path, {
        ...fetchOptions,
        signal: controller.signal,
        headers: {
          ...(fetchOptions.body && typeof fetchOptions.body !== 'string' ? { 'Content-Type': 'application/json' } : {}),
          ...fetchOptions.headers,
          Authorization: `Bearer ${token}`,
          ...(correlationId ? { 'X-Correlation-ID': correlationId } : {})
        },
        body
      })
      if (!response.ok) {
        let payload = {}
        try {
          payload = maxResponseBytes === undefined ? await response.json() : await boundedJSON(response, maxResponseBytes)
        } catch (error) {
          if (error instanceof ServiceError) throw error
        }
        const error = payload.error || {}
        throw new ServiceError(error.code || 'SERVICE_ERROR', error.message || `Service returned ${response.status}`, response.status, {
          retryAfter: response.headers.get('retry-after'),
          rateLimitLimit: response.headers.get('x-github-ratelimit-limit'),
          rateLimitRemaining: response.headers.get('x-github-ratelimit-remaining'),
          rateLimitReset: response.headers.get('x-github-ratelimit-reset')
        })
      }
      if (retainTimeout && timeoutThroughBody) {
        retained = true
        return { response, release, timedOut: () => timedOut }
      }
      return response
    } catch (error) {
      if (error instanceof ServiceError) throw error
      throw new ServiceError(timedOut ? 'SERVICE_TIMEOUT' : 'SERVICE_UNAVAILABLE', timedOut ? 'Service request timed out' : error.message, timedOut ? 504 : 502)
    } finally {
      if (!retained) release()
    }
  }

  return {
    json: async (path, options = {}) => {
      const retained = options.timeoutThroughBody
        ? await request(path, options, true)
        : { response: await request(path, options), release: () => {}, timedOut: () => false }
      try {
        return options.maxResponseBytes === undefined
          ? await retained.response.json()
          : await boundedJSON(retained.response, options.maxResponseBytes)
      } catch (error) {
        if (error instanceof ServiceError) throw error
        throw new ServiceError(retained.timedOut() ? 'SERVICE_TIMEOUT' : 'INVALID_SERVICE_RESPONSE', retained.timedOut() ? 'Service request timed out' : 'Service returned invalid JSON', retained.timedOut() ? 504 : 502)
      } finally {
        retained.release()
      }
    },
    request,
    stream: async (path, options = {}) => {
      if (!options.timeoutThroughBody) return (await request(path, options)).body
      const { response, release, timedOut } = await request(path, options, true)
      try {
        const source = typeof response.body.getReader === 'function' ? Readable.fromWeb(response.body) : response.body
        const output = Readable.from((async function * () {
          try {
            yield * source
          } catch (error) {
            throw new ServiceError(timedOut() ? 'SERVICE_TIMEOUT' : 'SERVICE_UNAVAILABLE', timedOut() ? 'Service request timed out' : error.message, timedOut() ? 504 : 502)
          }
        })())
        const safeRelease = () => {
          output.off('end', safeRelease).off('error', safeRelease).off('close', safeRelease)
          release()
        }
        output.once('end', safeRelease).once('error', safeRelease).once('close', safeRelease)
        return output
      } catch (error) {
        release()
        throw error
      }
    }
  }
}

async function boundedJSON (response, maximum) {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new TypeError('Invalid response size limit')
  const encoding = response.headers?.get?.('content-encoding')
  if (encoding && encoding !== 'identity') throw new ServiceError('INVALID_SERVICE_RESPONSE', 'Service returned compressed JSON', 502)
  const length = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(length) && length > maximum) throw responseTooLarge()

  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > maximum) throw responseTooLarge()
    chunks.push(bytes)
  }
  return strictJSON(Buffer.concat(chunks, size), maximum)
}

function responseTooLarge () {
  return new ServiceError('SERVICE_RESPONSE_TOO_LARGE', 'Service response is too large', 502)
}

module.exports = { ServiceError, createServiceClient }
