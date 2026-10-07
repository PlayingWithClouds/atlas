import { get, post } from './client';
import type { SessionStatus } from './types';

export type SourceKind = {
	id: string;
	label: string;
	plugin: string;
	itemNoun?: string;
	browsable?: boolean;
	thumbnails?: boolean;
	layout?: 'grid' | 'table' | 'form';
	input?: string;
	hint?: string;
	sample?: boolean;
};

export type SourceItem = {
	id: string;
	title: string;
	thumbnail?: string | null;
	count?: number | null;
	duration?: number | null;
	meta?: Record<string, unknown>;
};

export function listSourceKinds(): Promise<{ kinds: SourceKind[] }> {
	return get('/api/sources/kinds');
}

export function listSourceItems(
	kind: string,
	opts: { search?: string; limit?: number; offset?: number } = {}
): Promise<{ items: SourceItem[] }> {
	const params = new URLSearchParams({
		search: opts.search ?? '',
		limit: String(opts.limit ?? 40),
		offset: String(opts.offset ?? 0)
	});
	return get(`/api/sources/${kind}/items?${params}`);
}

// Open a source item as a labeling session. (Classes come from the project until
// the backend takes classes from the project directly in P2.)
export function openSource(
	kind: string,
	id: string | null,
	project: string,
	extra: { interval?: number } = {}
): Promise<SessionStatus> {
	const body: Record<string, unknown> = { project };
	if (kind === 'gallery') Object.assign(body, { source: 'gallery', galleryId: id });
	else if (kind === 'scene') Object.assign(body, { source: 'video', sceneId: id, intervalSeconds: extra.interval ?? 20 });
	else if (kind === 'directory') Object.assign(body, { source: 'directory', directory: id });
	// A local video file becomes a video session; a segment node cuts it into clips.
	else if (kind === 'videofile') Object.assign(body, { source: 'localvideo', path: id });
	else if (kind === 'random') Object.assign(body, { source: 'random' });
	else Object.assign(body, { source: kind });
	return post('/api/sessions', body);
}
