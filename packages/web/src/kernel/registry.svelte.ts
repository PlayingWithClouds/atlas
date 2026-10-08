import type { Dispose, Registry } from '@atlas/contracts/web';

interface Entry<T> {
  contribution: T;
  sequence: number;
}

function numberField(value: object, field: string): number | undefined {
  const candidate = (value as Record<string, unknown>)[field];
  if (typeof candidate === 'number') {
    return candidate;
  }
  return undefined;
}

/** `order` sorts ascending, `priority` descending; entries with neither keep registration order. */
function compareEntries<T extends { id: string }>(left: Entry<T>, right: Entry<T>): number {
  const leftOrder = numberField(left.contribution, 'order');
  const rightOrder = numberField(right.contribution, 'order');
  if (leftOrder !== undefined && rightOrder !== undefined && leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  const leftPriority = numberField(left.contribution, 'priority');
  const rightPriority = numberField(right.contribution, 'priority');
  if (leftPriority !== undefined && rightPriority !== undefined && leftPriority !== rightPriority) {
    return rightPriority - leftPriority;
  }
  return left.sequence - right.sequence;
}

/**
 * Ordered, reactive contribution list. Contributions are held raw (never proxied) so
 * components and class instances keep their identity.
 */
export function createRegistry<T extends { id: string }>(): Registry<T> {
  let entries = $state.raw<Entry<T>[]>([]);
  let nextSequence = 0;

  function register(contribution: T): Dispose {
    const entry: Entry<T> = { contribution, sequence: nextSequence };
    nextSequence += 1;
    const others = entries.filter((existing) => existing.contribution.id !== contribution.id);
    entries = [...others, entry].sort(compareEntries);
    return () => {
      entries = entries.filter((existing) => existing !== entry);
    };
  }

  function list(): T[] {
    return entries.map((entry) => entry.contribution);
  }

  function get(id: string): T | undefined {
    const found = entries.find((entry) => entry.contribution.id === id);
    if (!found) {
      return undefined;
    }
    return found.contribution;
  }

  return { register, list, get };
}
