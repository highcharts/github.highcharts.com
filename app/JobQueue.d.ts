export type JobArgs = {
    func: (...args: any[]) => Promise<any>;
    args: any[];
};
export type JobType = JobArgs & {
    setDone: (isDone: true) => void;
    done: Promise<true>;
};
export type Queues = 'download' | 'compile';
export type QueueType = Map<string, JobType>;
