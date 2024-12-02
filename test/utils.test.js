const { describe, it } = require('node:test')

const assert = require('node:assert')

const { shouldUseWebpack } = require('../app/utils.js')

describe('shouldUseWebpack', () => {
  it('returns true when tsconfig outputs to code/es-modules', () => {
    assert.equal(shouldUseWebpack(`{
      "outDir": "../code/es-modules/"
    }`), true)
  })

  it('returns false when tsconfig outputs to /js', () => {
    assert.equal(shouldUseWebpack(`{
      "outDir": "../js/"
    }`), false)
  })
})
