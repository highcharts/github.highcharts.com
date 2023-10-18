'use strict'
const __importDefault = (this && this.__importDefault) || function (mod) {
  return (mod && mod.__esModule) ? mod : { default: mod }
}
Object.defineProperty(exports, '__esModule', { value: true })
/* eslint-disable camelcase */
const node_crypto_1 = __importDefault(require('node:crypto'))
const node_process_1 = require('node:process')
// Max queue size per queue
const MAX_QUEUE_SIZE = Number(node_process_1.env.MAX_QUEUE_SIZE) || 10
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

  id
  async doJob (queue, jobID) {
    const job = queue.get(jobID)
    if (job) {
      job.func(...job.args)
        .catch((error) => {
          console.log(error)
        })
        .finally(() => {
          queue.delete(jobID)
          job.setDone(true)
        })
      await job.done
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
    const myJob = {
      ...job,
      setDone () { },
      done: Promise.resolve(true)
    }
    myJob.done = new Promise((resolve) => {
      myJob.setDone = resolve
    })
    return myJob
  }

  addJob (type, jobID, job) {
    const queue = JobQueue.queues[type]
    if (queue.size >= MAX_QUEUE_SIZE) {
      const error = new Error('Queue is full. Please wait a few minutes before trying again 😅')
      error.name = 'QueueFullError'
      return Promise.reject(error)
    }
    if (queue.has(jobID)) {
      return queue.get(jobID)?.done
    }
    const transformedJob = this.makeJob(job)
    queue.set(jobID, transformedJob)
    if (!JobQueue.churns[type]) {
      JobQueue.churns[type] = true
      return this.churn(queue)
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

  constructor () {
    this.id = node_crypto_1.default.randomUUID()
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
