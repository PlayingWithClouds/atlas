import type { NodeParam } from "@atlas/contracts";

export type Params = Record<string, unknown>;

/** Numeric strings are tolerated because the designer UI can send loosely typed params. */
export function numberParam(params: Params, key: string, fallback: number): number {
  const value = params[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return fallback;
}

export function stringParam(params: Params, key: string, fallback: string): string {
  const value = params[key];
  if (typeof value === "string" && value !== "") {
    return value;
  }
  return fallback;
}

export function thresholdParam(label: string, defaultValue: number, step: number): NodeParam {
  return { key: "threshold", kind: "number", label, default: defaultValue, min: 0, max: 1, step };
}
