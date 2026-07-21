'use strict';

type JobArgs = {
    func: (...args: any[]) => Promise<any>,
    args: any[];
}
type JobType = JobArgs & {
    setDone: (result: any) => void;
    setFailed: (error: unknown) => void;
    done: Promise<any>;
    queuedAt: number;
}
type Queues = 'download' | 'compile';
type QueueType = Map<string, JobType>;
type QueueMetrics = {
    active: number;
    queued: number;
    limit: number;
    available: number;
    oldestQueuedAgeMs: number | null;
}

/* eslint-disable camelcase */
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

    async doJob(queue: QueueType, jobID: string) {
        const job = queue.get(jobID);

        if (job) {
            try {
                const result = await Promise.resolve().then(() => job.func(...job.args));
                job.setDone(result);
            }
            catch (error) {
                job.setFailed(error);
                throw error;
            }
            finally {
                queue.delete(jobID);
            }
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
        const {
            promise: done,
            resolve: setDone,
            reject: setFailed
        } = Promise.withResolvers<any>();

        // Prevent an ignored caller promise from becoming an unhandled rejection.
        done.catch(() => {});

        return {
            ...job,
            setDone,
            setFailed,
            done,
            queuedAt: Date.now()
        };
    }

    public addJob(type: Queues, jobID: string, job: JobArgs) {
        const queue = JobQueue.queues[type];

        if (queue.size >= MAX_QUEUE_SIZE) {
            const error = new Error('Queue is full. Please wait a few minutes before trying again 😅');
            error.name = 'QueueFullError';

            return Promise.reject(error);
        }

        if (queue.has(jobID)) {
            return queue.get(jobID)!.done;
        }

        const transformedJob = this.makeJob(job)

        queue.set(
            jobID,
            transformedJob
        );

        if (!JobQueue.churns[type]) {
            JobQueue.churns[type] = true;

            this.churn(queue)
                .catch(console.error)
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

    public getMetrics(type: Queues, now = Date.now()): QueueMetrics {
        const queue = JobQueue.queues[type];
        const active = JobQueue.churns[type] && queue.size > 0 ? 1 : 0;
        const waiting = Array.from(queue.values()).slice(active);

        return {
            active,
            queued: waiting.length,
            limit: MAX_QUEUE_SIZE,
            available: Math.max(0, MAX_QUEUE_SIZE - queue.size),
            oldestQueuedAgeMs: waiting.length ? Math.max(0, now - waiting[0].queuedAt) : null
        };
    }

    constructor() {
        if (JobQueue._instance) {
            return JobQueue._instance
        }
        JobQueue._instance = this
    }
}

module.exports = {
    JobQueue
}

export type {
    JobArgs,
    JobType,
    Queues,
    QueueType,
    QueueMetrics,
    JobQueue
};
