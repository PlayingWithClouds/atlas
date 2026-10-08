import { describe, expect, test } from 'bun:test';
import type { RouteContribution } from '@atlas/contracts/web';
import { matchPath, matchRoute } from '../src/kernel/router.svelte';

function route(id: string, path: string): RouteContribution {
  return { id, path, component: (() => {}) as never };
}

describe('matchPath', () => {
  test('extracts and decodes params', () => {
    expect(matchPath('/projects/:project/session/:session', '/projects/a%20b/session/s1')).toEqual({
      project: 'a b',
      session: 's1',
    });
  });

  test('rejects different segment counts and literals', () => {
    expect(matchPath('/projects/:project', '/projects')).toBeUndefined();
    expect(matchPath('/projects/:project/data', '/projects/p/other')).toBeUndefined();
  });

  test('ignores trailing slashes', () => {
    expect(matchPath('/projects', '/projects/')).toEqual({});
  });
});

describe('matchRoute', () => {
  test('prefers the route with more literal segments', () => {
    const routes = [route('param', '/projects/:project/:page'), route('literal', '/projects/:project/data')];
    expect(matchRoute(routes, '/projects/p/data')?.route.id).toBe('literal');
  });

  test('returns undefined when nothing matches', () => {
    expect(matchRoute([route('a', '/a')], '/b')).toBeUndefined();
  });
});
