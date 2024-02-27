export type JobArgs = {
    func: (...args: any[]) => Promise<any>,
    args: any[];
}
export type JobType = JobArgs & {
    setDone: (isDone: true) => void;
    done: Promise<true>
}
export type Queues = 'download' | 'compile';
export type QueueType = Map<string, JobType>;

/* eslint-disable camelcase */
import crypto from 'node:crypto';
import { env } from 'node:process';

// Max queue size per queue
const MAX_QUEUE_SIZE = Number(env.MAX_QUEUE_SIZE) || 2;

class JobQueue {
    static _instance: JobQueue

    private static queues: Record<Queues, QueueType> = {
        download: new Map(),
        compile: new Map()
    }

    private static churns: Record<Queues, boolean> = {
        download: false,
        compile: false
    };

    public id: string;

    async doJob(queue: QueueType, jobID: string) {
        const job = queue.get(jobID);

        if (job) {
            job.func(...job.args)
                .catch((error) => {
                    console.log(error)
                })
                .finally(() => {
                    queue.delete(jobID)
                    job.setDone(true)
                });

            await job.done
        }
    }

    async churn(queue: QueueType): Promise<QueueType> {
        // Base case
        if (queue.size === 0) {
            return queue;
        }

        const jobID = queue.keys().next().value;

        try {
            await this.doJob(queue, jobID)
        }
        catch (error) {
            console.error(error);
        }
        finally {
            console.log(jobID, ' is done');
        }

        // Recurse till the queue is empty
        return this.churn(queue);
    }

    private makeJob(job: JobArgs): JobType {
        const myJob: JobType = {
            ...job,
            setDone() { },
            done: Promise.resolve(true)
        };

        myJob.done = new Promise((resolve) => {
            myJob.setDone = resolve;
        })

        return myJob;
    }

    public addJob(type: Queues, jobID: string, job: JobArgs) {
        const queue = JobQueue.queues[type];

        if (queue.size >= MAX_QUEUE_SIZE) {
            const error = new Error('Queue is full. Please wait a few minutes before trying again 😅');
            error.name = 'QueueFullError';

            return Promise.reject(error);
        }

        if (queue.has(jobID)) {
            return queue.get(jobID)?.done;
        }

        const transformedJob = this.makeJob(job)

        queue.set(
            jobID,
            transformedJob
        );

        if (!JobQueue.churns[type]) {
            JobQueue.churns[type] = true;

            return this.churn(queue)
                .finally(() => {
                    JobQueue.churns[type] = false;
                })
        }

        return transformedJob.done;
    }

    public getJobs(type: Queues) {
        const queue = JobQueue.queues[type];
        return Array.from(queue.entries());
    }

    public getJobPromises(type: Queues) {
        const queue = JobQueue.queues[type];
        return Array.from(queue.values());
    }

    constructor() {
        this.id = crypto.randomUUID()
        if (JobQueue._instance) {
            return JobQueue._instance
        }

        JobQueue._instance = this
    }
}

module.exports = {
    JobQueue
}
