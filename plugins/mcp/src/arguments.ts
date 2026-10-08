/**
 * Models are loose with types: an integer can turn up as a float, a string or nothing at all.
 * Every reader here coerces instead of asserting, and falls back instead of failing.
 */

export type ToolArguments = Record<string, unknown>;

type SchemaProperty = { type?: unknown; items?: unknown };

export function stringArgument(args: ToolArguments, key: string): string {
  const value = args[key];
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}

export function integerArgument(args: ToolArguments, key: string, fallback: number): number {
  const value = args[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

export function objectListArgument(args: ToolArguments, key: string): ToolArguments[] {
  const value = args[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is ToolArguments => typeof entry === "object" && entry !== null && !Array.isArray(entry));
}

export function stringListArgument(args: ToolArguments, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => String(entry));
}

/** Decodes a graph argument that may have arrived as a JSON string. */
export function graphArgument(args: ToolArguments, key: string): unknown {
  const value = args[key];
  if (value === undefined || value === null) {
    throw new Error(`${key} is required`);
  }
  if (typeof value === "string") {
    return parseJson(value, key);
  }
  return value;
}

function parseJson(text: string, key: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${key} is not valid JSON`);
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    return text;
  }
}

function coerceNumber(value: unknown, integer: boolean): unknown {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    return value;
  }
  if (integer) {
    return Math.trunc(parsed);
  }
  return parsed;
}

function coerceBoolean(value: unknown): unknown {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return value;
}

function coerceStructured(value: unknown, expected: "array" | "object"): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const parsed = tryParseJson(value);
  if (expected === "array" && Array.isArray(parsed)) {
    return parsed;
  }
  if (expected === "object" && typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return parsed;
  }
  return value;
}

function coerceString(value: unknown): unknown {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return value;
}

function coerceValue(value: unknown, property: SchemaProperty): unknown {
  switch (property.type) {
    case "integer":
      return coerceNumber(value, true);
    case "number":
      return coerceNumber(value, false);
    case "boolean":
      return coerceBoolean(value);
    case "string":
      return coerceString(value);
    case "array":
      return coerceStructured(value, "array");
    case "object":
      return coerceStructured(value, "object");
    default:
      return value;
  }
}

function asObject(raw: unknown): ToolArguments {
  if (typeof raw === "string") {
    const parsed = tryParseJson(raw);
    return asObject(typeof parsed === "string" ? undefined : parsed);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }
  return { ...(raw as ToolArguments) };
}

function propertiesOf(inputSchema: Record<string, unknown>): Record<string, SchemaProperty> {
  const properties = inputSchema.properties;
  if (typeof properties !== "object" || properties === null) {
    return {};
  }
  return properties as Record<string, SchemaProperty>;
}

/** Shapes raw wire arguments to the tool's input schema; unknown keys pass through untouched. */
export function coerceArguments(raw: unknown, inputSchema: Record<string, unknown>): ToolArguments {
  const args = asObject(raw);
  const properties = propertiesOf(inputSchema);
  for (const [key, property] of Object.entries(properties)) {
    if (args[key] === undefined || args[key] === null) {
      continue;
    }
    args[key] = coerceValue(args[key], property);
  }
  return args;
}
