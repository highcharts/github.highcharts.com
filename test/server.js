const { describe, it } = require('mocha')
const { ok, strictEqual } = require('assert')
const { addTypescriptJob, removeTypescriptJob, state } = require('../app/server')

describe('typescript job registry', () => {
  it('should add typescript job', () => {
    addTypescriptJob('master')
    ok(state.typescriptJobs['master'])
  })
  it('should not update value when same jobname is given', () => {
    const og = state.typescriptJobs['master']
    addTypescriptJob('master')
    strictEqual(og, state.typescriptJobs['master'])
  })
  it('should remove typescript job', () => {
    removeTypescriptJob('master')
    strictEqual(state.typescriptJobs['master'], undefined)
  })
})
