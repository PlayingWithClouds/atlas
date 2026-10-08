import type { ApiClient } from '@atlas/contracts/web';

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const API_PREFIX = '/api';

/** Accepts `/projects` and `/api/projects` alike so callers can copy server route paths. */
export function resolveApiPath(path: string): string {
  const absolute = path.startsWith('/') ? path : `/${path}`;
  if (absolute === API_PREFIX || absolute.startsWith(`${API_PREFIX}/`) || absolute.startsWith(`${API_PREFIX}?`)) {
    return absolute;
  }
  return `${API_PREFIX}${absolute}`;
}

async function errorMessageOf(response: Response): Promise<string> {
  const body = await response.json().catch(() => ({}));
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === 'string' && detail !== '') {
    return detail;
  }
  return response.statusText;
}

async function readBody<T>(response: Response): Promise<T> {
  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  if (text === '') {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

export function createApiClient(fetchImplementation: typeof fetch = fetch): ApiClient {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const response = await fetchImplementation(resolveApiPath(path), init);
    if (!response.ok) {
      throw new ApiError(await errorMessageOf(response), response.status);
    }
    return readBody<T>(response);
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body === undefined ? {} : body),
    put: (path, body) => request('PUT', path, body === undefined ? {} : body),
    patch: (path, body) => request('PATCH', path, body === undefined ? {} : body),
    delete: (path) => request('DELETE', path),
    url: resolveApiPath
  };
}
