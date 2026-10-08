import { describe, expect, test } from 'bun:test';
import { createRegistry } from '../src/kernel/registry.svelte';

interface Ordered {
  id: string;
  order: number;
}

interface Prioritized {
  id: string;
  priority: number;
}

describe('createRegistry', () => {
  test('sorts by ascending order', () => {
    const registry = createRegistry<Ordered>();
    registry.register({ id: 'c', order: 30 });
    registry.register({ id: 'a', order: 10 });
    registry.register({ id: 'b', order: 20 });
    expect(registry.list().map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });

  test('sorts by descending priority', () => {
    const registry = createRegistry<Prioritized>();
    registry.register({ id: 'low', priority: 1 });
    registry.register({ id: 'high', priority: 9 });
    expect(registry.list().map((entry) => entry.id)).toEqual(['high', 'low']);
  });

  test('keeps registration order without order or priority', () => {
    const registry = createRegistry<{ id: string }>();
    registry.register({ id: 'first' });
    registry.register({ id: 'second' });
    expect(registry.list().map((entry) => entry.id)).toEqual(['first', 'second']);
  });

  test('disposer removes only its own contribution', () => {
    const registry = createRegistry<Ordered>();
    const disposeA = registry.register({ id: 'a', order: 1 });
    registry.register({ id: 'b', order: 2 });
    disposeA();
    expect(registry.list().map((entry) => entry.id)).toEqual(['b']);
    disposeA();
    expect(registry.list()).toHaveLength(1);
  });

  test('re-registering an id replaces it and a stale disposer does not remove the replacement', () => {
    const registry = createRegistry<Ordered>();
    const disposeOld = registry.register({ id: 'a', order: 1 });
    registry.register({ id: 'a', order: 5 });
    expect(registry.list()).toHaveLength(1);
    disposeOld();
    expect(registry.get('a')?.order).toBe(5);
  });

  test('get returns undefined for unknown ids', () => {
    expect(createRegistry<Ordered>().get('missing')).toBeUndefined();
  });
});
