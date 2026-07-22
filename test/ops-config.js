'use strict'

const { expect } = require('chai')
const { randomBytes } = require('node:crypto')
const { describe, it } = require('mocha')
const {
  createTokenVerifier,
  parseOpsConfig,
  verifyToken
} = require('../app/ops/config')

describe('operations console configuration', () => {
  const token = randomBytes(32).toString('base64url')
  const enabled = overrides => ({
    OPS_CONSOLE_ENABLED: 'true',
    OPS_CONSOLE_TOKEN_VERIFIER: createTokenVerifier(token),
    OPS_CONSOLE_ORIGIN: 'https://ops.example.test',
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
      enabled({ OPS_CONSOLE_ORIGIN: 'ftp://ops.example.test' })
    ]) expect(() => parseOpsConfig(env)).to.throw()
  })

  it('uses HTTPS as the external origin without backend transport configuration', () => {
    const config = parseOpsConfig(enabled())
    expect(config).to.include({ enabled: true, origin: 'https://ops.example.test', protocol: 'https', allowHttpLoopback: false })
    expect(config).not.to.have.property('mtls')
  })

  it('rejects nonblank retired mTLS settings and ignores blank or disabled settings', () => {
    for (const name of [
      'OPS_CONSOLE_MTLS_PORT',
      'OPS_CONSOLE_MTLS_KEY_PATH',
      'OPS_CONSOLE_MTLS_CERT_PATH',
      'OPS_CONSOLE_MTLS_CA_PATH'
    ]) {
      expect(() => parseOpsConfig(enabled({ [name]: name.endsWith('PORT') ? '9443' : '/retired.pem' })))
        .to.throw('OPS_CONSOLE_MTLS_* settings are retired and unsupported')
      expect(parseOpsConfig(enabled({ [name]: '  ' })).protocol).to.equal('https')
      expect(parseOpsConfig({ OPS_CONSOLE_ENABLED: 'false', [name]: '/retired.pem' })).to.deep.equal({ enabled: false })
    }
  })

  it('rejects the legacy trusted-proxy setting whenever the console is enabled', () => {
    expect(() => parseOpsConfig(enabled({ OPS_CONSOLE_TRUSTED_PROXY: '127.0.0.1' }))).to.throw('OPS_CONSOLE_TRUSTED_PROXY is not supported')
    expect(parseOpsConfig(enabled({ OPS_CONSOLE_TRUSTED_PROXY: '' })).protocol).to.equal('https')
  })

  it('allows HTTP only for direct loopback mode', () => {
    expect(parseOpsConfig(enabled({
      OPS_CONSOLE_ORIGIN: 'http://127.1.2.3:8080',
      OPS_CONSOLE_ALLOW_HTTP_LOOPBACK: 'true'
    }))).to.include({ enabled: true, protocol: 'http', allowHttpLoopback: true })
    expect(parseOpsConfig(enabled({
      OPS_CONSOLE_ORIGIN: 'http://[::1]:8080',
      OPS_CONSOLE_ALLOW_HTTP_LOOPBACK: 'true'
    }))).to.include({ enabled: true, protocol: 'http', allowHttpLoopback: true })

    for (const overrides of [
      { OPS_CONSOLE_ORIGIN: 'http://localhost:8080' },
      { OPS_CONSOLE_ORIGIN: 'http://example.test', OPS_CONSOLE_ALLOW_HTTP_LOOPBACK: 'true' }
    ]) expect(() => parseOpsConfig(enabled(overrides))).to.throw('HTTP operations console')
  })
})
