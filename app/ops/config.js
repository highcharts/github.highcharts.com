'use strict'

const { createHash, timingSafeEqual } = require('node:crypto')
const { isIP } = require('node:net')
const { isAbsolute } = require('node:path')

const DOMAIN_SEPARATOR = Buffer.from('github.highcharts.com:ops-console:v1\0')
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/
const DEFAULT_MTLS_PORT = 8443

function decodeCanonical32 (value, name) {
  if (typeof value !== 'string' || !BASE64URL_32.test(value)) {
    throw new Error(`Invalid ${name}`)
  }
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.length !== 32 || decoded.toString('base64url') !== value) {
    throw new Error(`Invalid ${name}`)
  }
  return decoded
}

function tokenDigest (token) {
  return createHash('sha256')
    .update(DOMAIN_SEPARATOR)
    .update(decodeCanonical32(token, 'operations console token'))
    .digest()
}

function createTokenVerifier (token) {
  return `v1.${tokenDigest(token).toString('base64url')}`
}

function parseTokenVerifier (value) {
  if (typeof value !== 'string' || !value.startsWith('v1.')) {
    throw new Error('Invalid OPS_CONSOLE_TOKEN_VERIFIER')
  }
  return decodeCanonical32(value.slice(3), 'OPS_CONSOLE_TOKEN_VERIFIER')
}

function verifyToken (token, verifierDigest) {
  if (!Buffer.isBuffer(verifierDigest) || verifierDigest.length !== 32) {
    throw new Error('Invalid operations console token verifier')
  }
  let candidate = Buffer.alloc(32)
  try {
    candidate = tokenDigest(token)
  } catch (error) {}
  return timingSafeEqual(candidate, verifierDigest)
}

function parseOrigin (value) {
  if (typeof value !== 'string') throw new Error('Invalid OPS_CONSOLE_ORIGIN')
  let url
  try {
    url = new URL(value)
  } catch (error) {
    throw new Error('Invalid OPS_CONSOLE_ORIGIN')
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== value || url.username || url.password) {
    throw new Error('Invalid OPS_CONSOLE_ORIGIN')
  }
  return url
}

function nonblank (value) {
  return typeof value === 'string' && value.trim() !== ''
}

function parseAbsolutePath (value, name) {
  if (typeof value !== 'string' || value.trim() !== value || !isAbsolute(value)) throw new Error(`Invalid ${name}`)
  return value
}

function parsePort (value) {
  if (value === undefined || value === '') return DEFAULT_MTLS_PORT
  if (typeof value !== 'string' || !/^[1-9]\d{0,4}$/.test(value)) throw new Error('Invalid OPS_CONSOLE_MTLS_PORT')
  const port = Number(value)
  if (port > 65535) throw new Error('Invalid OPS_CONSOLE_MTLS_PORT')
  return port
}

function isLoopbackHost (hostname) {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true
  if (isIP(hostname) !== 4) return false
  return Number(hostname.split('.')[0]) === 127
}

function parseOpsConfig (env = process.env) {
  if (env.OPS_CONSOLE_ENABLED !== 'true') return Object.freeze({ enabled: false })

  const verifierDigest = parseTokenVerifier(env.OPS_CONSOLE_TOKEN_VERIFIER)
  const originURL = parseOrigin(env.OPS_CONSOLE_ORIGIN)
  const allowHttpLoopback = env.OPS_CONSOLE_ALLOW_HTTP_LOOPBACK === 'true'
  const mtlsNames = ['OPS_CONSOLE_MTLS_KEY_PATH', 'OPS_CONSOLE_MTLS_CERT_PATH', 'OPS_CONSOLE_MTLS_CA_PATH']
  const hasMTLSSetting = mtlsNames.some(name => nonblank(env[name])) || nonblank(env.OPS_CONSOLE_MTLS_PORT)

  if (nonblank(env.OPS_CONSOLE_TRUSTED_PROXY)) {
    throw new Error('OPS_CONSOLE_TRUSTED_PROXY is not supported; use operations console mTLS')
  }

  if (originURL.protocol === 'http:') {
    if (!allowHttpLoopback || !isLoopbackHost(originURL.hostname) || hasMTLSSetting) {
      throw new Error('HTTP operations console requires direct loopback mode without mTLS settings')
    }
    return Object.freeze({
      enabled: true,
      origin: originURL.origin,
      protocol: 'http',
      allowHttpLoopback,
      verifierDigest
    })
  }

  if (allowHttpLoopback) throw new Error('HTTPS operations console cannot allow HTTP loopback mode')
  const mtls = Object.freeze({
    port: parsePort(env.OPS_CONSOLE_MTLS_PORT),
    keyPath: parseAbsolutePath(env.OPS_CONSOLE_MTLS_KEY_PATH, 'OPS_CONSOLE_MTLS_KEY_PATH'),
    certPath: parseAbsolutePath(env.OPS_CONSOLE_MTLS_CERT_PATH, 'OPS_CONSOLE_MTLS_CERT_PATH'),
    caPath: parseAbsolutePath(env.OPS_CONSOLE_MTLS_CA_PATH, 'OPS_CONSOLE_MTLS_CA_PATH')
  })

  return Object.freeze({
    enabled: true,
    origin: originURL.origin,
    protocol: 'https',
    allowHttpLoopback: false,
    verifierDigest,
    mtls
  })
}

module.exports = {
  createTokenVerifier,
  DEFAULT_MTLS_PORT,
  parseOpsConfig,
  parseTokenVerifier,
  verifyToken
}
