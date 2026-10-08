import type { NodeParam } from "@atlas/contracts";

export type Params = Record<string, unknown>;

export function stringParam(params: Params, key: string, fallback: string): string {
  const value = params[key];
  if (typeof value === "string" && value !== "") {
    return value;
  }
  return fallback;
}

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

export function optionParam(key: string, label: string, values: string[], defaultValue: string): NodeParam {
  return {
    key,
    kind: "option",
    label,
    default: defaultValue,
    options: values.map((value) => ({ value, label: value })),
  };
}
