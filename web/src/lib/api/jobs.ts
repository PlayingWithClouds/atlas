import { get } from './client';
import type { Job } from './types';

export function listJobs(sessionId?: string, active = false): Promise<Job[]> {
	const params = new URLSearchParams();
	if (sessionId) params.set('session_id', sessionId);
	if (active) params.set('active', 'true');
	const query = params.toString();
	return get(`/api/jobs${query ? `?${query}` : ''}`);
}

export function getJob(id: string): Promise<Job> {
	return get(`/api/jobs/${id}`);
}
