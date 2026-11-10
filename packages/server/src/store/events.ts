import type { LiveEvent } from "@atlas/contracts";
import type { Dispose } from "@atlas/contracts/server";

type Listener = (event: LiveEvent) => void;

/** Fan-out of committed changes; one failing listener never affects the writer or the others. */
export class StoreEvents {
  private readonly listeners = new Set<Listener>();

  constructor(private readonly reportError: (error: unknown) => void) {}

  subscribe(listener: Listener): Dispose {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(...events: LiveEvent[]): void {
    for (const event of events) {
      this.notify(event);
    }
  }

  private notify(event: LiveEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.reportError(error);
      }
    }
  }
}
