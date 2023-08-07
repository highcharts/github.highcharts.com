const { describe, it, before, after } = require('node:test')

const assert = require('node:assert')

const { JobQueue } = require('../app/JobQueue.js')

function makeJob (time = 0, shouldReject = false) {
  return {
    func: function () {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          return shouldReject ? reject(new Error('reason')) : resolve('result')
        }, time)
      })
    },
    args: []
  }
}

describe('JobQueue', async () => {
  before(async () => { })

  after(async () => { })

  it('is a proper singleton', () => {
    const queue1 = new JobQueue()

    const queue2 = new JobQueue()

    assert.equal(queue1.id, queue2.id)
  })

  it('JobQueue', async () => {
    const queue = new JobQueue()
    const commit = '123123123'

    queue.addJob('download', commit, makeJob())

    const jobs = () => queue.getJobs('download')

    assert.equal(jobs().length, 1, 'Queue should be 1 after adding 1')
    queue.addJob('download', commit, makeJob())

    assert.equal(jobs().length, 1, 'Queue should be 1 after trying to add another job for same commit')

    queue.addJob('download', 'another', makeJob())
    assert.equal(jobs().length, 2, 'Queue length should be 2 after adding job for new commit')

    console.log(jobs())

    const firstJob = jobs()[0][1].done
    await firstJob

    assert.equal(jobs().length, 1, 'Queue length should be 1 after first job has finished')

    const oneLastJob = queue.addJob('download', 'anotherfailing', makeJob(1000, true))
    console.log({ oneLastJob })
    await oneLastJob

    assert.equal(jobs().length, 0, 'All jobs are done')
  })
})
