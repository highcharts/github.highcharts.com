'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
/* eslint-disable camelcase */
const node_process_1 = require('node:process')
// Max queue size per queue
const MAX_QUEUE_SIZE = Number(node_process_1.env.MAX_QUEUE_SIZE) || 2
class JobQueue {
  static _instance
  static queues = {
    download: new Map(),
    compile: new Map()
  }

  static churns = {
    download: false,
    compile: false
  }

  async doJob (queue, jobID) {
    const job = queue.get(jobID)
    if (job) {
      try {
        const result = await Promise.resolve().then(() => job.func(...job.args))
        job.setDone(result)
      } catch (error) {
        job.setFailed(error)
        throw error
      } finally {
        queue.delete(jobID)
      }
    }
  }

  async churn (queue) {
    // Base case
    if (queue.size === 0) {
      return queue
    }
    const jobID = queue.keys().next().value
    try {
      await this.doJob(queue, jobID)
    } catch (error) {
      console.error(error)
    } finally {
      console.log(jobID, ' is done')
    }
    // Recurse till the queue is empty
    return this.churn(queue)
  }

  makeJob (job) {
    const { promise: done, resolve: setDone, reject: setFailed } = Promise.withResolvers()
    // Prevent an ignored caller promise from becoming an unhandled rejection.
    done.catch(() => { })
    return {
      ...job,
      setDone,
      setFailed,
      done,
      queuedAt: Date.now()
    }
  }

  addJob (type, jobID, job) {
    const queue = JobQueue.queues[type]
    if (queue.size >= MAX_QUEUE_SIZE) {
      const error = new Error('Queue is full. Please wait a few minutes before trying again 😅')
      error.name = 'QueueFullError'
      return Promise.reject(error)
    }
    if (queue.has(jobID)) {
      return queue.get(jobID).done
    }
    const transformedJob = this.makeJob(job)
    queue.set(jobID, transformedJob)
    if (!JobQueue.churns[type]) {
      JobQueue.churns[type] = true
      this.churn(queue)
        .catch(console.error)
        .finally(() => {
          JobQueue.churns[type] = false
        })
    }
    return transformedJob.done
  }

  getJobs (type) {
    const queue = JobQueue.queues[type]
    return Array.from(queue.entries())
  }

  getJobPromises (type) {
    const queue = JobQueue.queues[type]
    return Array.from(queue.values())
  }

  getMetrics (type, now = Date.now()) {
    const queue = JobQueue.queues[type]
    const active = JobQueue.churns[type] && queue.size > 0 ? 1 : 0
    const waiting = Array.from(queue.values()).slice(active)
    return {
      active,
      queued: waiting.length,
      limit: MAX_QUEUE_SIZE,
      available: Math.max(0, MAX_QUEUE_SIZE - queue.size),
      oldestQueuedAgeMs: waiting.length ? Math.max(0, now - waiting[0].queuedAt) : null
    }
  }

  constructor () {
    if (JobQueue._instance) {
      return JobQueue._instance
    }
    JobQueue._instance = this
  }
}
module.exports = {
  JobQueue
}
// # sourceMappingURL=JobQueue.js.map
