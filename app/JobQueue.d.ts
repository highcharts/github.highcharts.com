type JobArgs = {
    func: (...args: any[]) => Promise<any>;
    args: any[];
};
type JobType = JobArgs & {
    setDone: (result: any) => void;
    setFailed: (error: unknown) => void;
    done: Promise<any>;
    queuedAt: number;
};
type Queues = 'download' | 'compile';
type QueueType = Map<string, JobType>;
type QueueMetrics = {
    active: number;
    queued: number;
    limit: number;
    available: number;
    oldestQueuedAgeMs: number | null;
};
declare class JobQueue {
    static _instance: JobQueue;
    private static queues;
    private static churns;
    doJob(queue: QueueType, jobID: string): Promise<void>;
    churn(queue: QueueType): Promise<QueueType>;
    private makeJob;
    addJob(type: Queues, jobID: string, job: JobArgs): Promise<any>;
    getJobs(type: Queues): [string, JobType][];
    getJobPromises(type: Queues): JobType[];
    getMetrics(type: Queues, now?: number): QueueMetrics;
    constructor();
}
export type { JobArgs, JobType, Queues, QueueType, QueueMetrics, JobQueue };
