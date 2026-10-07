// Shared response shapes from the backend.

// Playback for a video session. `url` is the backend's proxy, never the resolved
// stream URL — the CDN headers cannot travel with a browser request. `playback` is
// "clip" when the source ignores byte ranges, so each clip must be cut server-side.
export type SessionVideo = {
	url: string;
	duration: number;
	playback: 'direct' | 'clip';
};

export type SessionStatus = {
	id: string;
	label: string;
	source: string;
	ref?: string;
	classes: string[];
	total: number;
	embedded: number;
	labeled: number;
	skipped: number;
	head_trained: boolean;
	token: number;
	pool: number;
	producing: boolean;
	content_kind?: 'image' | 'video';
	video?: SessionVideo;
};

export type SessionListItem = {
	id: string;
	label: string;
	source: string;
	ref?: string;
	project?: string;
	producing: boolean;
	started: boolean;
	done: boolean;
	labeled: number;
	skipped: number;
	total: number;
};

export type NextImage = {
	done: boolean;
	waiting?: boolean;
	id?: number;
	suggestions?: Record<string, number>;
	existing?: string[];
	annotations?: import('$lib/primitives').Annotation[];
	status?: string;
	threshold?: number;
	// Temporal spans only: the time range this clip covers over the session's video.
	t_start?: number;
	t_end?: number;
};

export type GridItem = {
	id: number;
	status: string;
	tags: string[];
	t_start?: number;
	t_end?: number;
};

export type Gallery = { id: string; title: string; coverPath?: string; imageCount?: number };
export type Scene = { id: string; title: string; posterPath?: string; durationSeconds?: number };

export type Progress = {
	started: boolean;
	done: boolean;
	labeled: number;
	skipped: number;
	total: number;
};

export type Job = {
	id: string;
	type: string;
	session_id: string | null;
	phase: string;
	done: number;
	total: number;
	state: 'running' | 'done' | 'error' | 'interrupted';
	error: string;
	extra: Record<string, unknown>;
	created: number;
	updated: number;
};
