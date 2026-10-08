import { describe, expect, test } from 'bun:test';
import { ApiError, createApiClient, resolveApiPath } from '../src/kernel/api';

function fakeFetch(response: Response, calls: { url: string; init?: RequestInit }[] = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return response;
  }) as unknown as typeof fetch;
}

describe('resolveApiPath', () => {
  test('prefixes bare paths and keeps full api paths', () => {
    expect(resolveApiPath('/projects')).toBe('/api/projects');
    expect(resolveApiPath('projects')).toBe('/api/projects');
    expect(resolveApiPath('/api/projects')).toBe('/api/projects');
  });
});

describe('createApiClient', () => {
  test('maps the detail field of an error body to the message', async () => {
    const client = createApiClient(fakeFetch(Response.json({ detail: 'project not found' }, { status: 404 })));
    const failure = (await client.get('/projects/x').catch((error: unknown) => error)) as ApiError;
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.message).toBe('project not found');
    expect(failure.status).toBe(404);
  });

  test('falls back to the status text without a detail', async () => {
    const response = new Response('oops', { status: 500, statusText: 'Internal Server Error' });
    const failure = (await createApiClient(fakeFetch(response)).get('/x').catch((error: unknown) => error)) as ApiError;
    expect(failure.message).toBe('Internal Server Error');
  });

  test('returns undefined for 204 responses', async () => {
    const client = createApiClient(fakeFetch(new Response(null, { status: 204 })));
    expect(await client.delete('/sessions/s1')).toBeUndefined();
  });

  test('sends JSON bodies with the right method', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const client = createApiClient(fakeFetch(Response.json({ ok: true }), calls));
    await client.post('/projects', { name: 'n' });
    expect(calls[0].url).toBe('/api/projects');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.body).toBe('{"name":"n"}');
  });
});
