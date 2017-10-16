const mocha = require('mocha')
const expect = require('chai').expect
const defaults = require('../app/webhook.js')
const describe = mocha.describe
const it = mocha.it

describe('webhook.js', () => {
  describe('exported properties', () => {
    const functions = [
      'sha1',
      'validateWebHook',
      'validSignature'
    ]
    it('should have a default export', () => {
      functions.forEach((name) => {
        expect(defaults).to.have.property(name)
          .that.is.a('function')
      })
    })
    it('should not have unexpected properties', () => {
      const exportedProperties = Object.keys(defaults)
      expect(exportedProperties).to.deep.equal(functions)
    })
  })
  describe('sha1', () => {
    const sha1 = defaults.sha1
    it('should return false if secret is not a string', () => {
      expect(sha1(undefined, 'mydata')).to.equal(false)
    })
    it('should return false if data is not a string', () => {
      expect(sha1('mysecret', undefined)).to.equal(false)
    })
    it('should return a sha1 hash created with the secret and data', () => {
      expect(sha1('mysecret', 'mydata'))
        .to.equal('89ddafb4017e0e33cb6c0f9e9ddd6539c5f1d3cc')
    })
  })
  describe('validateWebHook', () => {
    const validateWebHook = defaults.validateWebHook
    it('should not validate when request is not an object', () => {
      const result = validateWebHook(undefined, 'mysecret')
      expect(result.valid).to.equal(false)
      expect(result.message).to.equal('Invalid input parameters')
    })
    it('should not validate when secureToken is not a string', () => {
      const result = validateWebHook({}, undefined)
      expect(result.valid).to.equal(false)
      expect(result.message).to.equal('Invalid input parameters')
    })
    it('should not validate when request.body is not an object', () => {
      const result = validateWebHook({
        body: undefined,
        rawBody: '{ ref: "abc" }',
        headers: {
          'x-hub-signature': 'sha1=d9a1c2c600bc4293c6e35ae85eb9a47ee18ad553'
        }
      }, 'mysecret')
      expect(result.valid).to.equal(false)
      expect(result.message).to.equal('Missing payload')
    })
    it('should not validate when request.rawBody is not a string', () => {
      const result = validateWebHook({
        body: {
          ref: 'abc'
        },
        rawBody: undefined,
        headers: {
          'x-hub-signature': 'sha1=d9a1c2c600bc4293c6e35ae85eb9a47ee18ad553'
        }
      }, 'mysecret')
      expect(result.valid).to.equal(false)
      expect(result.message).to.equal('Missing payload')
    })
    it('should not validate when signature is not a string', () => {
      const result = validateWebHook({
        body: {
          ref: 'abc'
        },
        rawBody: '{ ref: "abc" }',
        headers: {
          'x-hub-signature': undefined
        }
      }, 'mysecret')
      expect(result.valid).to.equal(false)
      expect(result.message).to.equal('Invalid signature')
    })
    it('should not validate when signature is invalid', () => {
      const result = validateWebHook({
        body: {
          ref: 'abc'
        },
        rawBody: '{ ref: "abc" }',
        headers: {
          'x-hub-signature': 'my-invalid-signature'
        }
      }, 'mysecret')
      expect(result.valid).to.equal(false)
      expect(result.message).to.equal('Invalid signature')
    })
    it('should not validate when request.body.ref is not a string', () => {
      const result = validateWebHook({
        body: {
          ref: undefined
        },
        rawBody: '{ ref: "abc" }',
        headers: {
          'x-hub-signature': 'sha1=d9a1c2c600bc4293c6e35ae85eb9a47ee18ad553'
        }
      }, 'mysecret')
      expect(result.valid).to.equal(false)
      expect(result.message).to.equal('Missing Git ref')
    })
    it('should validate when signature is valid, and body.ref is a string', () => {
      const result = validateWebHook({
        body: {
          ref: 'abc'
        },
        rawBody: '{ ref: "abc" }',
        headers: {
          'x-hub-signature': 'sha1=d9a1c2c600bc4293c6e35ae85eb9a47ee18ad553'
        }
      }, 'mysecret')
      expect(result.valid).to.equal(true)
      expect(result.message).to.equal('')
    })
  })
  describe('validSignature', () => {
    const validSignature = defaults.validSignature
    it('should return false when signature is not a string', () => {
      expect(validSignature(undefined, 'mydata', 'mysecret')).to.equal(false)
    })
    it('should return false when body is not a string', () => {
      expect(validSignature(
        '89ddafb4017e0e33cb6c0f9e9ddd6539c5f1d3cc',
        undefined,
        'mysecret'
      )).to.equal(false)
    })
    it('should return false when body is not a string', () => {
      expect(validSignature(
        '89ddafb4017e0e33cb6c0f9e9ddd6539c5f1d3cc',
        'mydata',
        undefined
      )).to.equal(false)
    })
    it('should return true when sha1 created from secret and body is matching signature', () => {
      expect(validSignature(
        'sha1=89ddafb4017e0e33cb6c0f9e9ddd6539c5f1d3cc',
        'mydata',
        'mysecret'
      )).to.equal(true)
    })
  })
})
