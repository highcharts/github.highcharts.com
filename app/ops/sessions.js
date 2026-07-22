'use strict'

const { randomBytes } = require('node:crypto')
const { OpsHttpError } = require('./http')

const SESSION_CAPACITY = 64
const IDLE_TIMEOUT_MS = 30 * 60 * 1000
const ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60 * 1000
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const API_WINDOW_MS = 60 * 1000

function randomOpaqueValue (bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

function createAuditId () {
  return randomOpaqueValue(16)
}

function sessionResponse (session) {
  return Object.freeze({
    authenticated: true,
    idleExpiresAt: new Date(Math.min(session.lastUsedAt + IDLE_TIMEOUT_MS, session.createdAt + ABSOLUTE_TIMEOUT_MS)).toISOString(),
    absoluteExpiresAt: new Date(session.createdAt + ABSOLUTE_TIMEOUT_MS).toISOString(),
    csrfToken: session.csrfToken
  })
}

class SessionStore {
  constructor ({ now = Date.now, generation = 0 } = {}) {
    this.now = now
    this.generation = generation
    this.sessions = new Map()
  }

  create (replaceSessionId) {
    const now = this.currentTime()
    this.pruneExpired(now)
    if (typeof replaceSessionId === 'string') this.sessions.delete(replaceSessionId)
    if (this.sessions.size >= SESSION_CAPACITY) {
      throw new OpsHttpError(503, 'SESSION_CAPACITY', 'Session capacity is unavailable')
    }

    let sessionId
    do sessionId = randomOpaqueValue()
    while (this.sessions.has(sessionId))

    const session = Object.freeze({
      createdAt: now,
      lastUsedAt: now,
      csrfToken: randomOpaqueValue(),
      generation: this.generation,
      auditId: createAuditId()
    })
    this.sessions.set(sessionId, session)
    return Object.freeze({ sessionId, session })
  }

  authenticate (sessionId, { renew = true } = {}) {
    if (typeof sessionId !== 'string') return null
    const now = this.currentTime()
    const session = this.sessions.get(sessionId)
    if (!session || this.isExpired(session, now) || session.generation !== this.generation) {
      this.sessions.delete(sessionId)
      return null
    }
    if (!renew) return session

    const renewed = Object.freeze({ ...session, lastUsedAt: now })
    this.sessions.set(sessionId, renewed)
    return renewed
  }

  revoke (sessionId) {
    return typeof sessionId === 'string' && this.sessions.delete(sessionId)
  }

  rotate (generation = this.generation + 1) {
    if (generation === this.generation) return 0
    const revoked = this.sessions.size
    this.sessions.clear()
    this.generation = generation
    return revoked
  }

  pruneExpired (now = this.currentTime()) {
    let removed = 0
    for (const [sessionId, session] of this.sessions) {
      if (!this.isExpired(session, now) && session.generation === this.generation) continue
      this.sessions.delete(sessionId)
      removed++
    }
    return removed
  }

  get size () {
    return this.sessions.size
  }

  currentTime () {
    const now = this.now()
    if (!Number.isFinite(now)) throw new Error('Session clock returned an invalid time')
    return now
  }

  isExpired (session, now) {
    return now >= session.lastUsedAt + IDLE_TIMEOUT_MS || now >= session.createdAt + ABSOLUTE_TIMEOUT_MS
  }
}

class OpsRateLimiter {
  constructor ({ now = Date.now } = {}) {
    this.now = now
    this.snapshotSessions = new Map()
    this.cacheSessions = new Map()
    this.loginGlobal = null
    this.cacheGlobal = null
  }

  attemptLogin () {
    const now = this.currentTime()
    this.prune(now)
    return this.consumeGlobal('loginGlobal', 30, LOGIN_WINDOW_MS, now)
  }

  attemptSnapshot (sessionId) {
    const now = this.currentTime()
    this.prune(now)
    return this.consume(this.snapshotSessions, sessionId, 12, API_WINDOW_MS, SESSION_CAPACITY, now)
  }

  attemptCacheOperation (sessionId) {
    const now = this.currentTime()
    this.prune(now)
    const perSession = this.consume(this.cacheSessions, sessionId, 5, API_WINDOW_MS, SESSION_CAPACITY, now)
    const global = this.consumeGlobal('cacheGlobal', 20, API_WINDOW_MS, now)
    return combineLimits(perSession, global)
  }

  removeSession (sessionId) {
    this.snapshotSessions.delete(sessionId)
    this.cacheSessions.delete(sessionId)
  }

  prune (now = this.currentTime()) {
    for (const buckets of [this.snapshotSessions, this.cacheSessions]) {
      for (const [key, bucket] of buckets) {
        if (now >= bucket.resetAt) buckets.delete(key)
      }
    }
    if (this.loginGlobal && now >= this.loginGlobal.resetAt) this.loginGlobal = null
    if (this.cacheGlobal && now >= this.cacheGlobal.resetAt) this.cacheGlobal = null
  }

  get bucketCounts () {
    return Object.freeze({
      snapshotSessions: this.snapshotSessions.size,
      cacheSessions: this.cacheSessions.size
    })
  }

  currentTime () {
    const now = this.now()
    if (!Number.isFinite(now)) throw new Error('Rate-limit clock returned an invalid time')
    return now
  }

  consume (buckets, key, limit, windowMs, capacity, now) {
    if (typeof key !== 'string' || !key) throw new Error('Invalid rate-limit key')
    const bucket = buckets.get(key)
    if (!bucket && buckets.size >= capacity) {
      const resetAt = Math.min(...Array.from(buckets.values(), value => value.resetAt))
      return limitResult(false, 0, resetAt, now)
    }
    if (bucket) {
      buckets.delete(key)
      buckets.set(key, bucket)
    }
    const current = bucket || { count: 0, resetAt: now + windowMs }
    if (current.count >= limit) return limitResult(false, 0, current.resetAt, now)

    current.count++
    buckets.set(key, current)
    return limitResult(true, limit - current.count, current.resetAt, now)
  }

  consumeGlobal (name, limit, windowMs, now) {
    let bucket = this[name]
    if (!bucket) bucket = { count: 0, resetAt: now + windowMs }
    if (bucket.count >= limit) return limitResult(false, 0, bucket.resetAt, now)
    bucket.count++
    this[name] = bucket
    return limitResult(true, limit - bucket.count, bucket.resetAt, now)
  }
}

function limitResult (allowed, remaining, resetAt, now) {
  return Object.freeze({
    allowed,
    remaining,
    retryAfter: allowed ? 0 : Math.max(1, Math.ceil((resetAt - now) / 1000)),
    resetAt
  })
}

function combineLimits (...results) {
  const denied = results.filter(result => !result.allowed)
  if (!denied.length) {
    return limitResult(true, Math.min(...results.map(result => result.remaining)), Math.max(...results.map(result => result.resetAt)), 0)
  }
  return Object.freeze({
    allowed: false,
    remaining: 0,
    retryAfter: Math.max(...denied.map(result => result.retryAfter)),
    resetAt: Math.max(...denied.map(result => result.resetAt))
  })
}

module.exports = {
  ABSOLUTE_TIMEOUT_MS,
  API_WINDOW_MS,
  IDLE_TIMEOUT_MS,
  LOGIN_WINDOW_MS,
  OpsRateLimiter,
  SESSION_CAPACITY,
  SessionStore,
  createAuditId,
  sessionResponse
}
