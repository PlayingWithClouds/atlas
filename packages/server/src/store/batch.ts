import type { BatchResult } from "@atlas/contracts";
import { ValidationFailure } from "@atlas/contracts/server";
import { isRecord } from "./parsing";

export const MAXIMUM_BATCH_SIZE = 1000;

export function requireBatch(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) {
    throw new ValidationFailure(["the body must be a JSON array of records"]);
  }
  if (raw.length > MAXIMUM_BATCH_SIZE) {
    throw new ValidationFailure([`a batch holds at most ${MAXIMUM_BATCH_SIZE} records, got ${raw.length}`]);
  }
  return raw;
}

/** The id to report for a record that may not even be an object. */
export function recordLabel(raw: unknown, index: number, idField = "id"): string {
  if (isRecord(raw) && typeof raw[idField] === "string") {
    return raw[idField] as string;
  }
  return `#${index}`;
}

export class BatchRecorder {
  private accepted = 0;
  private readonly errors: BatchResult["errors"] = [];

  accept(): void {
    this.accepted += 1;
  }

  reject(id: string, message: string): void {
    this.errors.push({ id, message });
  }

  result(): BatchResult {
    return { ok: this.accepted, errors: this.errors };
  }
}
