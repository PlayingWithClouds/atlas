/** Caps how many <video> elements play at once; each one costs a decoder and a connection. */
export const MAX_CONCURRENT_PLAYERS = 12;

export interface PlayerBudget {
  /** Returns whether a slot was granted. */
  acquire(): boolean;
  release(): void;
  inUse(): number;
}

export function createPlayerBudget(limit: number): PlayerBudget {
  let used = 0;
  return {
    acquire() {
      if (used >= limit) {
        return false;
      }
      used += 1;
      return true;
    },
    release() {
      used = Math.max(0, used - 1);
    },
    inUse() {
      return used;
    },
  };
}

/** Shared by every video cell on the page. */
export const playerBudget = createPlayerBudget(MAX_CONCURRENT_PLAYERS);
