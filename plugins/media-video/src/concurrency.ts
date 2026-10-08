/** Caps how many async jobs run at once; the rest wait in arrival order. */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    // The slot is handed over directly by release(), so `active` stays unchanged.
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next === undefined) {
      this.active -= 1;
      return;
    }
    next();
  }
}

/** Concurrent callers asking for the same key share one in-flight piece of work. */
export class SingleFlight<T> {
  private readonly flights = new Map<string, Promise<T>>();

  run(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.flights.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const flight = work().finally(() => this.flights.delete(key));
    this.flights.set(key, flight);
    return flight;
  }
}

/** Runs `work` over every entry with at most `limit` in flight. */
export async function forEachConcurrent<T>(entries: T[], limit: number, work: (entry: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < entries.length) {
      const entry = entries[nextIndex];
      nextIndex += 1;
      await work(entry);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, entries.length) }, worker));
}
