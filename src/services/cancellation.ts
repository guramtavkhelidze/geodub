const cancelledJobs = new Map<string, boolean>();

export function setCancelled(jobId: string) {
    cancelledJobs.set(jobId, true);
}

export function isCancelled(jobId: string): boolean {
    return cancelledJobs.get(jobId) === true;
}

export function clearJob(jobId: string) {
    cancelledJobs.delete(jobId);
}
