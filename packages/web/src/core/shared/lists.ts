/** Accepts either a bare array or an object wrapping it under `key`. */
export function listFrom<T>(payload: unknown, key: string): T[] {
  if (Array.isArray(payload)) {
    return payload as T[];
  }
  if (payload && typeof payload === 'object') {
    const wrapped = (payload as Record<string, unknown>)[key];
    if (Array.isArray(wrapped)) {
      return wrapped as T[];
    }
  }
  return [];
}
