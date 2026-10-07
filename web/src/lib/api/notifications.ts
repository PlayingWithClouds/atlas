import { get, post } from './client';

// Persistent tray notification; keyed entries are updated in place by the backend.
export type Notification = {
	id: string;
	key?: string;
	message: string;
	session?: string;
	level?: 'info' | 'success' | 'error';
	created: string;
	updated?: string;
};

// Transient toast pushed once over the live socket; never stored.
export type Toast = {
	id: string;
	message: string;
	session?: string;
	level?: 'info' | 'success' | 'error';
};

export function getNotifications(): Promise<{ notifications: Notification[] }> {
	return get('/api/notifications');
}

export function dismissNotification(id: string): Promise<{ ok: boolean }> {
	return post('/api/notifications/dismiss', { id });
}

export function clearNotifications(): Promise<{ ok: boolean }> {
	return post('/api/notifications/clear', {});
}
