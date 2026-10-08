import fs from "node:fs";
import type { SurrealReader } from "./surrealClient";
import { isRecord, stripRecordPrefix } from "./mapping";
import type { JsonRecord, OldImage, OldProject, OldSession } from "./mapping";

export const IMAGE_PAGE_SIZE = 1000;

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface OldConfigFile {
  config: JsonRecord;
  /** True when the file was missing and an empty config was substituted. */
  missing: boolean;
}

/** Reads atlas.config.json (title, primitives, labels, workflows) without touching it. */
export function readOldConfig(configPath: string): OldConfigFile {
  if (!fs.existsSync(configPath)) {
    return { config: {}, missing: true };
  }
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error(`${configPath} must contain a JSON object`);
  }
  return { config: parsed, missing: false };
}

export async function loadOldProjects(reader: SurrealReader): Promise<OldProject[]> {
  const rows = await reader.query<OldProject>(
    "SELECT meta::id(id) AS id, name, config, created, updated FROM project",
  );
  return rows.map((row) => ({ ...row, id: stripRecordPrefix(String(row.id), "project") }));
}

export async function loadOldSessions(reader: SurrealReader): Promise<OldSession[]> {
  const rows = await reader.query<OldSession>(
    "SELECT meta::id(id) AS id, project, source, ref, label, frames_dir, video, producing, created, segment FROM session ORDER BY created",
  );
  return rows.map((row) => ({ ...row, id: stripRecordPrefix(String(row.id), "session") }));
}

export async function loadImageCounts(reader: SurrealReader): Promise<Map<string, number>> {
  const rows = await reader.query<{ session: string; count: number }>(
    "SELECT session, count() AS count FROM image GROUP BY session",
  );
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(stripRecordPrefix(String(row.session), "session"), row.count);
  }
  return counts;
}

async function loadImagePage(reader: SurrealReader, sessionId: string, start: number): Promise<OldImage[]> {
  if (!SAFE_ID_PATTERN.test(sessionId)) {
    throw new Error(`refusing to query session with unexpected id "${sessionId}"`);
  }
  const rows = await reader.query<OldImage>(
    `SELECT meta::id(id) AS id, idx, ref, annotations, skipped, embedded, status, t_start, t_end FROM image WHERE session = ${JSON.stringify(sessionId)} ORDER BY idx LIMIT ${IMAGE_PAGE_SIZE} START ${start}`,
  );
  return rows.map((row) => ({ ...row, id: stripRecordPrefix(String(row.id), "image") }));
}

/** Yields one session's image rows in `idx` order, page by page. */
export async function* loadImages(reader: SurrealReader, sessionId: string): AsyncGenerator<OldImage[]> {
  let start = 0;
  while (true) {
    const page = await loadImagePage(reader, sessionId, start);
    if (page.length === 0) {
      return;
    }
    yield page;
    start += page.length;
  }
}
