import fs from "node:fs";
import path from "node:path";

/** Project class name to the Danbooru tags that imply it. */
export type TagMapping = Record<string, string[]>;

export interface MappingSource {
  mapping?: unknown;
  mappingFile?: string;
}

export const MAPPING_REQUIRED_MESSAGE =
  "tagger-joytag needs a class mapping: set `mapping` or `mappingFile` in the plugin config (see examples/mapping.json)";

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function parseMapping(raw: unknown): TagMapping {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("tagger-joytag mapping must be an object of className -> string[]");
  }
  const mapping: TagMapping = {};
  for (const [className, tags] of Object.entries(raw)) {
    if (!isStringList(tags)) {
      throw new Error(`tagger-joytag mapping for "${className}" must be a list of tag names`);
    }
    mapping[className] = tags;
  }
  return mapping;
}

function readMappingFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`tagger-joytag cannot read mappingFile ${filePath}: ${reason}`);
  }
}

/** Inline `mapping` wins over `mappingFile`; relative file paths resolve against the workspace. */
export function loadMapping(source: MappingSource, workspaceDirectory: string): TagMapping {
  if (source.mapping !== undefined) {
    return parseMapping(source.mapping);
  }
  if (source.mappingFile !== undefined && source.mappingFile !== "") {
    return parseMapping(readMappingFile(path.resolve(workspaceDirectory, source.mappingFile)));
  }
  throw new Error(MAPPING_REQUIRED_MESSAGE);
}

/** Max-pools raw tag probabilities into the project's classes; classes with no signal are omitted. */
export function classProbabilities(tagScores: Record<string, number>, mapping: TagMapping, classes: string[]): Record<string, number> {
  const probabilities: Record<string, number> = {};
  for (const className of classes) {
    const tags = mapping[className] || [];
    const strongest = Math.max(0, ...tags.map((tag) => tagScores[tag] || 0));
    if (strongest > 0) {
      probabilities[className] = strongest;
    }
  }
  return probabilities;
}

/** The highest-scoring raw tags, rounded for display in downstream notifications. */
export function topTags(tagScores: Record<string, number>, limit: number): Record<string, number> {
  const ranked = Object.entries(tagScores).sort((left, right) => right[1] - left[1]);
  const top: Record<string, number> = {};
  for (const [tag, score] of ranked.slice(0, limit)) {
    top[tag] = Math.round(score * 1000) / 1000;
  }
  return top;
}
