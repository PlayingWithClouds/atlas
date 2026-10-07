import { writable } from 'svelte/store';
import { browser } from '$app/environment';
import { jobs } from './jobs';
import { sessions } from './sessions';
import { plugins } from './plugins';
import { notifications, pushToast } from './notifications';

// Connection state, so the UI can show "reconnecting" if the backend drops.
export const connected = writable(false);

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function open(): void {
	const proto = location.protocol === 'https:' ? 'wss' : 'ws';
	socket = new WebSocket(`${proto}://${location.host}/api/ws`);

	socket.onopen = () => connected.set(true);

	socket.onmessage = (event) => {
		try {
			const msg = JSON.parse(event.data);
			if (msg.type === 'state') {
				if (Array.isArray(msg.jobs)) jobs.set(msg.jobs);
				if (Array.isArray(msg.sessions)) sessions.set(msg.sessions);
				if (Array.isArray(msg.plugins)) plugins.set(msg.plugins);
				if (Array.isArray(msg.notifications)) notifications.set(msg.notifications);
			} else if (msg.type === 'toast' && msg.toast) {
				pushToast(msg.toast);
			}
		} catch {
			// ignore malformed frame
		}
	};

	socket.onclose = () => {
		connected.set(false);
		socket = null;
		scheduleReconnect();
	};

	socket.onerror = () => socket?.close();
}

function scheduleReconnect(): void {
	if (reconnectTimer) return;
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		open();
	}, 2000);
}

// Open the single live connection. Idempotent; the server pushes a full snapshot
// on connect, so no initial fetch is needed.
export function connectLive(): void {
	if (!browser || socket) return;
	open();
}
