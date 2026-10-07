import { del, get, post } from './client';
import type { SessionListItem, SessionStatus } from './types';

export function listSessions(): Promise<SessionListItem[]> {
	return get('/api/sessions');
}

export function sessionStatus(sid: string): Promise<SessionStatus> {
	return get(`/api/sessions/${sid}`);
}

export function deleteSession(sid: string): Promise<{ ok: boolean }> {
	return del(`/api/sessions/${sid}`);
}

// Lifecycle signals that fire workflow triggers (session_opened / session_closed).
export function sessionOpened(sid: string): Promise<{ ok: boolean }> {
	return post(`/api/sessions/${sid}/opened`, {});
}

export function sessionClosed(sid: string): Promise<{ ok: boolean }> {
	return post(`/api/sessions/${sid}/closed`, {});
}

// Opening a source now goes through openSource() in api/sources.ts (generic,
// project-scoped). The old per-kind start* helpers were removed with the redesign.
