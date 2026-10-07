import { get, post, patch, del } from './client';
import type { GridItem, NextImage } from './types';
import type { Annotation } from '$lib/primitives';

export function getNext(sid: string): Promise<NextImage> {
	return get(`/api/sessions/${sid}/next`);
}

export function getItem(sid: string, id: number): Promise<NextImage> {
	return get(`/api/sessions/${sid}/item/${id}`);
}

export function imageUrl(sid: string, id: number, token = 0): string {
	return `/api/sessions/${sid}/image/${id}?s=${token}`;
}

// The session's video, proxied by the backend so the CDN headers are applied.
// A clip plays a range of it via the "#t=start,end" media fragment.
export function sessionVideoUrl(sid: string): string {
	return `/api/sessions/${sid}/video`;
}

// A single clip cut server-side. Used when the source ignores byte ranges (HLS)
// and to preview a trim: start/end override the span's stored range.
export function clipUrl(sid: string, id: number, start?: number, end?: number): string {
	const params = new URLSearchParams();
	if (start !== undefined) params.set('start', start.toFixed(3));
	if (end !== undefined) params.set('end', end.toFixed(3));
	const query = params.toString();
	if (!query) return `/api/sessions/${sid}/clip/${id}`;
	return `/api/sessions/${sid}/clip/${id}?${query}`;
}

// A still from the middle of a clip, cached server-side under its exact range, so a
// cell that is not playing still shows the clip.
export function posterUrl(sid: string, id: number, start?: number, end?: number): string {
	const params = new URLSearchParams();
	if (start !== undefined) params.set('start', start.toFixed(3));
	if (end !== undefined) params.set('end', end.toFixed(3));
	const query = params.toString();
	if (!query) return `/api/sessions/${sid}/poster/${id}`;
	return `/api/sessions/${sid}/poster/${id}?${query}`;
}

export type SpanUpdate = {
	ok: boolean;
	id: number;
	t_start: number;
	t_end: number;
	status: string;
	embedded: boolean;
	reembedding: boolean;
};

// Move a span's time range. The backend rewrites its ref and re-embeds it, since
// the vector pool is keyed by the ref.
export function updateSpan(sid: string, id: number, tStart: number, tEnd: number): Promise<SpanUpdate> {
	return patch(`/api/sessions/${sid}/item/${id}/span`, { t_start: tStart, t_end: tEnd });
}

export function postLabel(sid: string, id: number, labels: string[]): Promise<{ ok: boolean; labeled: number; poolSize: number }> {
	return post(`/api/sessions/${sid}/label`, { id, labels });
}

export function postAnnotations(sid: string, id: number, annotations: Annotation[]): Promise<{ ok: boolean; labeled: number; poolSize: number }> {
	return post(`/api/sessions/${sid}/label`, { id, annotations });
}

export function postSkip(sid: string, id: number): Promise<{ ok: boolean; skipped: number }> {
	return post(`/api/sessions/${sid}/skip`, { id });
}

// Remove an image from the session entirely (unlike skip, which keeps it).
export function deleteImage(sid: string, id: number): Promise<{ ok: boolean; total: number }> {
	return del(`/api/sessions/${sid}/image/${id}`);
}

export function listImages(sid: string, filter = 'all', sort = 'natural'): Promise<GridItem[]> {
	return get(`/api/sessions/${sid}/images?filter=${filter}&sort=${sort}`);
}

export function findDuplicates(
	sid: string,
	threshold = 0.93
): Promise<{ clusters: { keep: number; dupes: number[] }[]; duplicates: number[]; count: number }> {
	return get(`/api/sessions/${sid}/duplicates?threshold=${threshold}`);
}

// A text search over a session's clips, ranked by SigLIP's text tower against the
// vectors already stored. It reads existing embeddings only — `unembedded` reports the
// clips it could not consider, rather than the search quietly covering less than it says.
export type SearchHit = { idx: number; ref: string; score: number; status: string };

export type SearchResponse = {
	query: string;
	hits: SearchHit[];
	scored: number;
	unembedded: number;
	message?: string;
};

export function searchSession(sid: string, query: string, limit = 60): Promise<SearchResponse> {
	return get(`/api/sessions/${sid}/search?q=${encodeURIComponent(query)}&limit=${limit}`);
}
