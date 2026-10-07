import { writable } from 'svelte/store';
import type { Notification, Toast } from '$lib/api/notifications';

// Persistent notifications, kept in sync from the live WebSocket snapshot.
// They stay in the bell tray until the user dismisses them.
export const notifications = writable<Notification[]>([]);

// Transient toasts, pushed once over the socket and auto-removed after a delay.
export const toasts = writable<Toast[]>([]);

const toastLifetimeMs = 5000;

export function pushToast(toast: Toast): void {
	toasts.update((current) => [...current, toast]);
	setTimeout(() => dismissToast(toast.id), toastLifetimeMs);
}

export function dismissToast(id: string): void {
	toasts.update((current) => current.filter((toast) => toast.id !== id));
}
