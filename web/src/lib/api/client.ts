// Single fetch wrapper for the Python backend. In dev, Vite proxies /api → :8123
// (set PUBLIC_API_URL to point elsewhere). All requests are same-origin so
// <img src={apiUrl(...)}> works with the relative path too.

export function apiUrl(path: string): string {
	return path.startsWith('/') ? path : `/${path}`;
}

// Route a remote veil image through veil's cache/hotlink proxy (dev-proxied at /veil).
export function veilImg(remoteUrl: string): string {
	return `/veil/api/img?url=${encodeURIComponent(remoteUrl)}`;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
	const response = await fetch(apiUrl(path), options);
	if (!response.ok) {
		const detail = await response.json().catch(() => ({}));
		throw new Error((detail as { detail?: string }).detail || response.statusText);
	}
	return response.json() as Promise<T>;
}

export function get<T>(path: string): Promise<T> {
	return request<T>(path);
}

export function post<T>(path: string, body?: unknown): Promise<T> {
	return request<T>(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body ?? {})
	});
}

export function put<T>(path: string, body?: unknown): Promise<T> {
	return request<T>(path, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body ?? {})
	});
}

export function patch<T>(path: string, body?: unknown): Promise<T> {
	return request<T>(path, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body ?? {})
	});
}

export function del<T>(path: string): Promise<T> {
	return request<T>(path, { method: 'DELETE' });
}
