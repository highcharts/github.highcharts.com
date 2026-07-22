const { describe, it } = require('mocha')

const assert = require('node:assert')

const { JobQueue } = require('../app/JobQueue.js')

function deferred () {
  let resolveJob
  let rejectJob
  const promise = new Promise((resolve, reject) => {
    resolveJob = resolve
    rejectJob = reject
  })

  return { promise, resolve: resolveJob, reject: rejectJob }
}

function makeJob (func) {
  return { func, args: [] }
}

describe('JobQueue', () => {
  it('is a proper singleton', () => {
    const queue1 = new JobQueue()
    const queue2 = new JobQueue()

    assert.strictEqual(queue1, queue2)
  })

  it('returns the job result and cleans up the queue', async () => {
    const queue = new JobQueue()
    const result = { built: true }

    const promise = queue.addJob('download', 'success', makeJob(async () => result))

    assert.strictEqual(await promise, result)
    assert.equal(queue.getJobs('download').length, 0)
  })

  it('returns the same result promise to duplicate callers', async () => {
    const queue = new JobQueue()
    const job = deferred()
    const first = queue.addJob('download', 'duplicate-success', makeJob(() => job.promise))
    const duplicate = queue.addJob('download', 'duplicate-success', makeJob(async () => 'wrong'))

    assert.strictEqual(first, duplicate)

    job.resolve('result')
    assert.equal(await first, 'result')
    assert.equal(await duplicate, 'result')
  })

  it('rejects duplicate callers with the original error', async () => {
    const queue = new JobQueue()
    const job = deferred()
    const error = new Error('reason')
    const first = queue.addJob('download', 'duplicate-failure', makeJob(() => job.promise))
    const duplicate = queue.addJob('download', 'duplicate-failure', makeJob(async () => 'wrong'))

    assert.strictEqual(first, duplicate)

    job.reject(error)
    await assert.rejects(first, (caught) => caught === error)
    await assert.rejects(duplicate, (caught) => caught === error)
    assert.equal(queue.getJobs('download').length, 0)
  })

  it('continues with the next queued job after a failure', async () => {
    const queue = new JobQueue()
    const firstJob = deferred()
    const error = new Error('first failed')
    const calls = []
    const first = queue.addJob('download', 'failing-first', makeJob(async () => {
      calls.push('first')
      return firstJob.promise
    }))
    const second = queue.addJob('download', 'successful-second', makeJob(async () => {
      calls.push('second')
      return 'second result'
    }))

    firstJob.reject(error)

    await assert.rejects(first, (caught) => caught === error)
    assert.equal(await second, 'second result')
    assert.deepEqual(calls, ['first', 'second'])
    assert.equal(queue.getJobs('download').length, 0)
  })
})
