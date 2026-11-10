import { HttpError } from "@atlas/contracts/server";

/** Cursors are opaque to clients but numeric here; absent means "from the start". */
export function readCursor(cursor: string | undefined, name: string): number {
  if (cursor === undefined || cursor === "") {
    return 0;
  }
  if (!/^\d+$/.test(cursor)) {
    throw new HttpError(400, `${name} must be a cursor returned by this endpoint`);
  }
  return Number(cursor);
}

export function readLimit(limit: string | undefined, fallback: number, maximum: number): number {
  if (limit === undefined || limit === "") {
    return fallback;
  }
  const parsed = Number(limit);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new HttpError(400, "limit must be a positive integer");
  }
  return Math.min(parsed, maximum);
}
