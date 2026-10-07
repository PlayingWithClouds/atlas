import { get } from './client';

export type Stats = {
	pool: number;
	backbone: string;
	sessions: number;
	images: number;
	labeled: number;
	processing: number;
	jobs_active: number;
};

// Stats are per project: each keeps its own sessions, data and training pool.
export function getStats(project: string): Promise<Stats> {
	return get(`/api/stats?project=${encodeURIComponent(project)}`);
}
