/** Upper bound for model work that sits on a user-facing request path. */
export const INTERACTIVE_BUDGET_MILLISECONDS = 1500;

/** Resolves with `fallback` when the promise is late or rejects; the late result is ignored. */
export function withDeadline<T>(promise: Promise<T>, milliseconds: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), milliseconds);
    const settle = (value: T) => {
      clearTimeout(timer);
      resolve(value);
    };
    promise.then(settle, () => settle(fallback));
  });
}

export function withInteractiveDeadline<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return withDeadline(promise, INTERACTIVE_BUDGET_MILLISECONDS, fallback);
}
