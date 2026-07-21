'use strict'

const { expect } = require('chai')
const { randomBytes } = require('node:crypto')
const { join } = require('node:path')
const { describe, it } = require('mocha')
const {
  createTokenVerifier,
  DEFAULT_MTLS_PORT,
  parseOpsConfig,
  verifyToken
} = require('../app/ops/config')

describe('operations console configuration', () => {
  const token = randomBytes(32).toString('base64url')
  const absolute = name => join(__dirname, 'fixtures/mtls', name)
  const enabled = overrides => ({
    OPS_CONSOLE_ENABLED: 'true',
    OPS_CONSOLE_TOKEN_VERIFIER: createTokenVerifier(token),
    OPS_CONSOLE_ORIGIN: 'https://ops.example.test',
    OPS_CONSOLE_MTLS_KEY_PATH: absolute('server.key'),
    OPS_CONSOLE_MTLS_CERT_PATH: absolute('server.crt'),
    OPS_CONSOLE_MTLS_CA_PATH: absolute('ca.crt'),
    ...overrides
  })

  it('is disabled unless explicitly enabled and ignores disabled secrets', () => {
    expect(parseOpsConfig({ NODE_ENV: 'development', OPS_CONSOLE_TOKEN_VERIFIER: 'secret' })).to.deep.equal({ enabled: false })
    expect(parseOpsConfig({ OPS_CONSOLE_ENABLED: 'TRUE' })).to.deep.equal({ enabled: false })
  })

  it('creates and checks only canonical domain-separated verifiers', () => {
    const verifier = createTokenVerifier(token)
    const config = parseOpsConfig(enabled())
    expect(verifier).to.match(/^v1\.[A-Za-z0-9_-]{43}$/)
    expect(verifyToken(token, config.verifierDigest)).to.equal(true)
    expect(verifyToken(randomBytes(32).toString('base64url'), config.verifierDigest)).to.equal(false)
    expect(verifyToken('not-a-token', config.verifierDigest)).to.equal(false)
    expect(verifyToken('', config.verifierDigest)).to.equal(false)
    expect(verifyToken(undefined, config.verifierDigest)).to.equal(false)
    for (const invalid of [undefined, '', Buffer.alloc(0), Buffer.alloc(31)]) {
      expect(() => verifyToken(token, invalid)).to.throw('Invalid operations console token verifier')
    }
  })

  it('fails enabled startup for missing, malformed, or noncanonical settings', () => {
    for (const env of [
      enabled({ OPS_CONSOLE_TOKEN_VERIFIER: undefined }),
      enabled({ OPS_CONSOLE_TOKEN_VERIFIER: `v2.${'A'.repeat(43)}` }),
      enabled({ OPS_CONSOLE_ORIGIN: 'https://ops.example.test/' }),
      enabled({ OPS_CONSOLE_ORIGIN: 'HTTPS://ops.example.test' }),
      enabled({ OPS_CONSOLE_ORIGIN: 'ftp://ops.example.test' }),
      enabled({ OPS_CONSOLE_MTLS_KEY_PATH: undefined }),
      enabled({ OPS_CONSOLE_MTLS_CERT_PATH: undefined }),
      enabled({ OPS_CONSOLE_MTLS_CA_PATH: undefined }),
      enabled({ OPS_CONSOLE_MTLS_KEY_PATH: 'server.key' }),
      enabled({ OPS_CONSOLE_MTLS_CERT_PATH: './server.crt' }),
      enabled({ OPS_CONSOLE_MTLS_CA_PATH: 'ca.crt' })
    ]) expect(() => parseOpsConfig(env)).to.throw()
  })

  it('requires dedicated HTTPS mTLS paths and a strict bounded port defaulting to 8443', () => {
    const config = parseOpsConfig(enabled())
    expect(DEFAULT_MTLS_PORT).to.equal(8443)
    expect(config.mtls).to.deep.equal({
      port: 8443,
      keyPath: absolute('server.key'),
      certPath: absolute('server.crt'),
      caPath: absolute('ca.crt')
    })
    expect(parseOpsConfig(enabled({ OPS_CONSOLE_MTLS_PORT: '1' })).mtls.port).to.equal(1)
    expect(parseOpsConfig(enabled({ OPS_CONSOLE_MTLS_PORT: '65535' })).mtls.port).to.equal(65535)
    for (const port of ['0', '01', '65536', '-1', '8443 ', '1.5']) {
      expect(() => parseOpsConfig(enabled({ OPS_CONSOLE_MTLS_PORT: port }))).to.throw('Invalid OPS_CONSOLE_MTLS_PORT')
    }
  })

  it('rejects the legacy trusted-proxy setting whenever the console is enabled', () => {
    expect(() => parseOpsConfig(enabled({ OPS_CONSOLE_TRUSTED_PROXY: '127.0.0.1' }))).to.throw('OPS_CONSOLE_TRUSTED_PROXY is not supported')
    expect(parseOpsConfig(enabled({ OPS_CONSOLE_TRUSTED_PROXY: '' })).protocol).to.equal('https')
  })

  it('allows HTTP only for direct loopback mode', () => {
    expect(parseOpsConfig(enabled({
      OPS_CONSOLE_ORIGIN: 'http://127.1.2.3:8080',
      OPS_CONSOLE_ALLOW_HTTP_LOOPBACK: 'true',
      OPS_CONSOLE_MTLS_KEY_PATH: undefined,
      OPS_CONSOLE_MTLS_CERT_PATH: undefined,
      OPS_CONSOLE_MTLS_CA_PATH: undefined
    }))).to.include({ enabled: true, protocol: 'http', allowHttpLoopback: true })
    expect(parseOpsConfig(enabled({
      OPS_CONSOLE_ORIGIN: 'http://[::1]:8080',
      OPS_CONSOLE_ALLOW_HTTP_LOOPBACK: 'true',
      OPS_CONSOLE_MTLS_KEY_PATH: undefined,
      OPS_CONSOLE_MTLS_CERT_PATH: undefined,
      OPS_CONSOLE_MTLS_CA_PATH: undefined
    }))).to.include({ enabled: true, protocol: 'http', allowHttpLoopback: true })

    for (const overrides of [
      { OPS_CONSOLE_ORIGIN: 'http://localhost:8080' },
      { OPS_CONSOLE_ORIGIN: 'http://example.test', OPS_CONSOLE_ALLOW_HTTP_LOOPBACK: 'true' },
      { OPS_CONSOLE_ORIGIN: 'http://[::1]:8080', OPS_CONSOLE_ALLOW_HTTP_LOOPBACK: 'true', OPS_CONSOLE_MTLS_PORT: '9443' },
      { OPS_CONSOLE_ORIGIN: 'http://[::1]:8080', OPS_CONSOLE_ALLOW_HTTP_LOOPBACK: 'true', OPS_CONSOLE_MTLS_CA_PATH: absolute('ca.crt') }
    ]) expect(() => parseOpsConfig(enabled(overrides))).to.throw('HTTP operations console')
  })
})
