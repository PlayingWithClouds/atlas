import type { ApiClient } from '@atlas/contracts/web';

export class ApiError extends Error {
  readonly status: number;
  /** Every problem of a `422 { errors }` answer; a single entry for other failures. */
  readonly problems: string[];

  constructor(message: string, status: number, problems: string[] = [message]) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.problems = problems;
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

function problemsOf(body: { errors?: unknown; detail?: unknown }, fallback: string): string[] {
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    return body.errors.map((problem) => String(problem));
  }
  if (typeof body.detail === 'string' && body.detail !== '') {
    return [body.detail];
  }
  return [fallback];
}

async function failureOf(response: Response): Promise<ApiError> {
  const body = await response.json().catch(() => ({}));
  const problems = problemsOf(body as { errors?: unknown; detail?: unknown }, response.statusText);
  return new ApiError(problems.join('; '), response.status, problems);
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
      throw await failureOf(response);
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
