const mocha = require('mocha')
// const expect = require('chai').expect
// const defaults = require('../app/router.js')
require('../app/router.js')
const describe = mocha.describe
const it = mocha.it

describe('router.js', () => {
  describe('exported properties', () => {
    it('is missing tests. The router.js returns an ExpressJS Router where it is not very meaningful to test its properties.')
  })
})
