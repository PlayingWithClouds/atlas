import { describe, expect, test } from 'bun:test';
import { LiveState, parseLiveEvent, webSocketUrl } from '../src/kernel/live.svelte';

describe('live events', () => {
  test('parses a frame into an event and ignores junk', () => {
    expect(parseLiveEvent('{"type":"items","projectId":"p","ids":["a"]}')).toEqual({ type: 'items', projectId: 'p', ids: ['a'] });
    expect(parseLiveEvent('not json')).toBeUndefined();
    expect(parseLiveEvent('{"no":"type"}')).toBeUndefined();
  });

  test('uses the /api/live socket on the page origin', () => {
    expect(webSocketUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/api/live');
    expect(webSocketUrl({ protocol: 'https:', host: 'atlas.example' })).toBe('wss://atlas.example/api/live');
  });

  test('delivers events to subscribers until they unsubscribe', () => {
    const state = new LiveState();
    const seen: string[] = [];
    const unsubscribe = state.subscribe((signal) => seen.push(signal.type));
    state.emit({ type: 'projects' });
    unsubscribe();
    state.emit({ type: 'projects' });
    expect(seen).toEqual(['projects']);
  });
});
