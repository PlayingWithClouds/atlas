import type { Annotation, WorkItem } from "@atlas/contracts";
import type { NodeType } from "@atlas/contracts/server";
import { optionParam, stringParam } from "../params";
import type { Params } from "../params";

export interface FilterPredicate {
  field: string;
  op: string;
  value: string;
}

export function predicateFrom(params: Params): FilterPredicate {
  return {
    field: stringParam(params, "field", "status"),
    op: stringParam(params, "op", "is"),
    value: stringParam(params, "value", ""),
  };
}

/** Class names an annotation carries, read from the conventional `labels` / `label` value keys. */
export function labelsOf(annotations: Annotation[]): string[] {
  const names: string[] = [];
  for (const annotation of annotations) {
    const { labels, label } = annotation.value;
    if (Array.isArray(labels)) {
      names.push(...labels.filter((name): name is string => typeof name === "string"));
    }
    if (typeof label === "string") {
      names.push(label);
    }
  }
  return names;
}

function annotationsOf(item: WorkItem): Annotation[] {
  if (Array.isArray(item.annotations)) {
    return item.annotations;
  }
  return [];
}

function numericField(item: WorkItem, field: string): number | undefined {
  if (field === "duration") {
    if (item.span === undefined) {
      return undefined;
    }
    return item.span.end - item.span.start;
  }
  const value = item[field];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function matchesAnnotation(item: WorkItem, predicate: FilterPredicate): boolean {
  const annotations = annotationsOf(item);
  let found = labelsOf(annotations).includes(predicate.value);
  if (predicate.field === "annotation") {
    found = annotations.some((annotation) => annotation.type === predicate.value);
  }
  if (predicate.op === "not") {
    return !found;
  }
  return found;
}

function matchesNumeric(item: WorkItem, predicate: FilterPredicate): boolean {
  const value = numericField(item, predicate.field);
  const wanted = Number(predicate.value);
  if (value === undefined || predicate.value.trim() === "" || Number.isNaN(wanted)) {
    return false;
  }
  if (predicate.op === "lt") {
    return value < wanted;
  }
  return value > wanted;
}

function matchesText(item: WorkItem, predicate: FilterPredicate): boolean {
  const value = item[predicate.field];
  if (value === undefined || value === null) {
    return false;
  }
  if (predicate.op === "not") {
    return String(value) !== predicate.value;
  }
  return String(value) === predicate.value;
}

/** An item missing the field never matches, whichever way the condition points. */
export function matchesPredicate(item: WorkItem, predicate: FilterPredicate): boolean {
  if (predicate.field === "annotation" || predicate.field === "label") {
    return matchesAnnotation(item, predicate);
  }
  if (predicate.op === "gt" || predicate.op === "lt") {
    return matchesNumeric(item, predicate);
  }
  return matchesText(item, predicate);
}

export function applyFilter(items: WorkItem[], predicate: FilterPredicate): WorkItem[] {
  return items.filter((item) => matchesPredicate(item, predicate));
}

const FIELDS = ["status", "embedded", "duration", "confidence", "annotation", "label"];
const OPERATORS = ["is", "not", "gt", "lt"];

export const filterNode: NodeType = {
  type: "filter",
  plugin: "core-nodes",
  label: "Filter",
  description: "Keep only the items matching a condition",
  input: "items",
  output: "items",
  params: [
    optionParam("field", "Field", FIELDS, "status"),
    optionParam("op", "Operator", OPERATORS, "is"),
    { key: "value", kind: "string", label: "Value", default: "" },
  ],
  async run(items, context) {
    return { items: applyFilter(items, predicateFrom(context.params)) };
  },
  dryRun(items, context) {
    return applyFilter(items, predicateFrom(context.params));
  },
};
