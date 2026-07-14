'use strict'

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

  async function request (path, requestOptions = {}) {
    const controller = new AbortController()
    const externalSignal = requestOptions.signal
    const abort = () => controller.abort()
    externalSignal?.addEventListener('abort', abort, { once: true })
    if (externalSignal?.aborted) abort()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, requestOptions.timeout || timeout)
    try {
      const response = await fetchImpl(baseURL + path, {
        ...requestOptions,
        signal: controller.signal,
        headers: {
          ...(requestOptions.body && typeof requestOptions.body !== 'string' ? { 'Content-Type': 'application/json' } : {}),
          Authorization: `Bearer ${token}`,
          ...requestOptions.headers
        },
        body: requestOptions.body && typeof requestOptions.body !== 'string'
          ? JSON.stringify(requestOptions.body)
          : requestOptions.body
      })
      if (!response.ok) {
        let payload = {}
        try { payload = await response.json() } catch (e) {}
        const error = payload.error || {}
        throw new ServiceError(error.code || 'SERVICE_ERROR', error.message || `Service returned ${response.status}`, response.status, {
          retryAfter: response.headers.get('retry-after'),
          rateLimitLimit: response.headers.get('x-github-ratelimit-limit'),
          rateLimitRemaining: response.headers.get('x-github-ratelimit-remaining'),
          rateLimitReset: response.headers.get('x-github-ratelimit-reset')
        })
      }
      return response
    } catch (error) {
      if (error instanceof ServiceError) throw error
      throw new ServiceError(timedOut ? 'SERVICE_TIMEOUT' : 'SERVICE_UNAVAILABLE', timedOut ? 'Service request timed out' : error.message, timedOut ? 504 : 502)
    } finally {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', abort)
    }
  }

  return {
    json: async (path, options) => (await request(path, options)).json(),
    request,
    stream: async (path, options) => (await request(path, options)).body
  }
}

module.exports = { ServiceError, createServiceClient }
