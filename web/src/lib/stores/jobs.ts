import { writable, derived } from 'svelte/store';
import { listJobs } from '../api/jobs';
import type { Job } from '../api/types';

// Populated by the live WebSocket (stores/live.ts). refreshJobs is a one-shot
// fallback for the rare places that want to force an immediate fetch.
export const jobs = writable<Job[]>([]);

export const activeJobs = derived(jobs, ($jobs) => $jobs.filter((job) => job.state === 'running'));

export async function refreshJobs(): Promise<void> {
	try {
		jobs.set(await listJobs());
	} catch {
		// backend down; keep last known
	}
}

// Count of running jobs for a given session (sidebar / session-view badges).
export function sessionJobs(sessionId: string) {
	return derived(activeJobs, ($active) => $active.filter((job) => job.session_id === sessionId));
}
