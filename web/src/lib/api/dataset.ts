import { post } from './client';
import type { Job } from './types';

export function exportDataset(path?: string): Promise<{ ok: boolean; dir: string; job?: Job }> {
	return post('/api/dataset/export', { path: path || null });
}

export function importDataset(path?: string): Promise<{ ok: boolean; dir: string; job?: Job }> {
	return post('/api/dataset/import', { path: path || null });
}
