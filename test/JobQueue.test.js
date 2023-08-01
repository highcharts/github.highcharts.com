const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')

const { JobQueue } = require('../app/JobQueue.js')

describe('JobQueue', async () => {
  before(async () => {
  })

  after(async () => {
  })

  it('JobQueue', async () => {
    const queue = new JobQueue()

    const commit = '123123123'

    queue.addDownloadJob(commit, Promise.resolve())
    assert.ok(queue.downloadJobs[commit])

    await queue.addDownloadJob(commit, Promise.resolve())
  })
})
