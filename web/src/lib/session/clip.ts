// Shared helpers for temporal spans (video clips): time formatting and which URL
// a clip plays from — the whole-video proxy when the source answers byte ranges,
// a server-cut clip when it does not.
import { clipUrl, sessionVideoUrl } from '$lib/api/label';
import type { SessionStatus } from '$lib/api/types';

export const MIN_SPAN_SECONDS = 0.25;

export function formatTime(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const minutes = Math.floor(total / 60);
	const rest = total % 60;
	if (minutes < 60) {
		return `${minutes}:${String(rest).padStart(2, '0')}`;
	}
	const hours = Math.floor(minutes / 60);
	return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

export function formatRange(start: number, end: number): string {
	return `${formatTime(start)}–${formatTime(end)}`;
}

export function isClipPlayback(status: SessionStatus): boolean {
	return status.video?.playback === 'clip';
}

export type ClipPlayback = { src: string; start: number; end: number };

// Where the clip plays: one cell of a grid, or the single-clip labeler.
export type PlaybackContext = 'grid' | 'single';

// What a clip plays. The server-cut clip starts at zero, so the player's range shifts
// with it; the whole-video proxy keeps the clip's own timestamps.
//
// A grid always takes the cut. Pointing a cell at the whole video makes the player
// buffer far past the four seconds it will show — on a feature-length file that is
// tens of megabytes per cell, and it holds one of the six connections the browser
// allows per host while it does, which is what starves the posters in the other cells.
export function clipPlayback(
	status: SessionStatus,
	sid: string,
	id: number,
	start: number,
	end: number,
	context: PlaybackContext = 'single'
): ClipPlayback {
	if (context === 'grid' || isClipPlayback(status)) {
		return { src: clipUrl(sid, id, start, end), start: 0, end: Math.max(end - start, MIN_SPAN_SECONDS) };
	}
	return { src: sessionVideoUrl(sid), start, end };
}
