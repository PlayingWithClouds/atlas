import { writable } from 'svelte/store';
import { listSessions } from '../api/sessions';
import type { SessionListItem } from '../api/types';

// Populated by the live WebSocket (stores/live.ts). refreshSessions is a one-shot
// fallback for the rare places that want to force an immediate fetch.
export const sessions = writable<SessionListItem[]>([]);

export async function refreshSessions(): Promise<void> {
	try {
		sessions.set(await listSessions());
	} catch {
		// backend down; keep last known
	}
}
