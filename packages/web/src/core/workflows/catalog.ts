import type { NodeSpec, TriggerSpec } from '@atlas/contracts';

export type CatalogMap = Map<string, NodeSpec>;

/** Svelte context key sharing the fetched catalog (type -> spec) between Designer and its nodes. */
export const CATALOG_CONTEXT = Symbol('workflow-catalog');

const PORT_COLORS: Record<string, string> = {
  items: '#60a5fa',
};
const FALLBACK_PORT_COLOR = '#94a3b8';

export const TRIGGER_SCOPE_LABEL: Record<TriggerSpec['scope'], string> = {
  global: 'No input',
  session: 'Session items',
  item: 'Single item',
};

export function portColor(kind: string): string {
  const color = PORT_COLORS[kind];
  if (color === undefined) {
    return FALLBACK_PORT_COLOR;
  }
  return color;
}

export function hasInput(spec: NodeSpec | undefined): boolean {
  return spec !== undefined && spec.input !== 'none';
}

export function hasOutput(spec: NodeSpec | undefined): boolean {
  return spec !== undefined && spec.output !== 'none';
}

function describeFields(prefix: string, fields: Record<string, unknown> | undefined): string[] {
  if (!fields) {
    return [];
  }
  return Object.entries(fields).map(([key, value]) => `${prefix}${key}=${value}`);
}

/** What a node consumes: the item stream plus its accepts criteria. */
export function inputTypeLabel(spec: NodeSpec): string {
  if (spec.input === 'none') {
    return 'none';
  }
  const criteria = describeFields('', spec.accepts);
  if (criteria.length === 0) {
    return spec.input;
  }
  return `${spec.input} (${criteria.join(', ')})`;
}

/** What a node produces: the item stream plus the fields it sets on its output. */
export function outputTypeLabel(spec: NodeSpec): string {
  if (spec.output === 'none') {
    return 'none';
  }
  const fields = describeFields('+', spec.emits);
  if (fields.length === 0) {
    return spec.output;
  }
  return `${spec.output} (${fields.join(', ')})`;
}

/**
 * True when wiring source -> target is not provably wrong: a connection is rejected only when
 * the source explicitly emits a field value that conflicts with the target's accepts.
 */
export function outputSatisfies(source: NodeSpec, target: NodeSpec): boolean {
  const emits = source.emits ?? {};
  for (const [key, wanted] of Object.entries(target.accepts ?? {})) {
    if (key in emits && String(emits[key]) !== String(wanted)) {
      return false;
    }
  }
  return true;
}

export function defaultParams(spec: NodeSpec): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const param of spec.params) {
    params[param.key] = param.default;
  }
  return params;
}

/** Trigger id -> scope; unknown triggers (from unloaded plugins) count as session scoped. */
export function scopeOfTrigger(triggers: TriggerSpec[], triggerId: string): TriggerSpec['scope'] {
  const found = triggers.find((trigger) => trigger.id === triggerId);
  if (!found) {
    return 'session';
  }
  return found.scope;
}
