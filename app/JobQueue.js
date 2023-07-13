class JobQueue {
  /**
   * @type {JobQueue}
   * @static
   */
  static _instance

  downloadJobs = {}
  compileJobs = {}

  /**
     * @param {Promise<any>} job
     */
  addDownloadJob (commit, job) {
    if (!this.downloadJobs[commit]) {
      this.downloadJobs[commit] = job
    }

    return this.downloadJobs[commit].finally(() => {
      delete this.downloadJobs[commit]
    })
  }

  /**
     * @param {Promise<any>} job
     */
  addCompileJob (commit, job) {
    if (!this.compileJobs[commit]) {
      this.compileJobs[commit] = job
    }

    return this.compileJobs[commit]
      .finally(() => {
        delete this.compileJobs[commit]
      })
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
