import { Service } from "@neoworks/extension-system";
import type { Context } from "@neoworks/extension-system";
import { classNamesOf, parseSpanRef, spanRef } from "@atlas/contracts";
import type {
  Annotation,
  Item,
  ItemStatus,
  Project,
  Session,
  SessionStatus,
  SessionSummary,
  SourceRef,
  Span,
} from "@atlas/contracts";
import { HttpError } from "@atlas/contracts/server";
import type { ItemsService, NewItem } from "@atlas/contracts/server";
import { shortId } from "./ids";

interface SessionRow {
  id: string;
  project_id: string;
  label: string;
  source: string;
  producing: number;
  created: string;
  meta: string;
}

interface ItemRow {
  id: string;
  session_id: string;
  idx: number;
  ref: string;
  media_kind: string;
  status: ItemStatus;
  annotations: string;
  embedded: number;
  span_start: number | null;
  span_end: number | null;
  meta: string;
}

interface SummaryRow {
  id: string;
  label: string;
  project_id: string;
  producing: number;
  total: number;
  labeled: number;
  skipped: number;
}

const ITEMS_MIGRATION = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    source TEXT NOT NULL,
    producing INTEGER NOT NULL DEFAULT 0,
    created TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX sessions_project ON sessions (project_id);
  CREATE TABLE items (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    ref TEXT NOT NULL,
    media_kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    annotations TEXT NOT NULL DEFAULT '[]',
    embedded INTEGER NOT NULL DEFAULT 0,
    span_start REAL,
    span_end REAL,
    meta TEXT NOT NULL DEFAULT '{}',
    UNIQUE (session_id, idx),
    UNIQUE (session_id, ref)
  );
  CREATE INDEX items_session_status ON items (session_id, status);
`;

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    projectId: row.project_id,
    label: row.label,
    source: JSON.parse(row.source) as SourceRef,
    producing: row.producing === 1,
    created: row.created,
    meta: JSON.parse(row.meta) as Record<string, unknown>,
  };
}

function rowToItem(row: ItemRow): Item {
  const item: Item = {
    id: row.id,
    sessionId: row.session_id,
    index: row.idx,
    ref: row.ref,
    mediaKind: row.media_kind,
    status: row.status,
    annotations: JSON.parse(row.annotations) as Annotation[],
    embedded: row.embedded === 1,
    meta: JSON.parse(row.meta) as Record<string, unknown>,
  };
  if (row.span_start !== null && row.span_end !== null) {
    item.span = { start: row.span_start, end: row.span_end };
  }
  return item;
}

function rowToSummary(row: SummaryRow): SessionSummary {
  return {
    id: row.id,
    label: row.label,
    projectId: row.project_id,
    producing: row.producing === 1,
    total: row.total,
    labeled: row.labeled,
    skipped: row.skipped,
  };
}

function storedRef(newItem: NewItem): string {
  if (newItem.span === undefined) {
    return newItem.ref;
  }
  return spanRef(newItem.ref, newItem.span);
}

function integerFlag(value: boolean): number {
  if (value) {
    return 1;
  }
  return 0;
}

export class ItemsCore extends Service implements ItemsService {
  static inject = ["db", "live", "projects", "models"];

  constructor(ctx: Context) {
    super(ctx, "items");
    ctx.db.migrate("items", [{ version: 1, sql: ITEMS_MIGRATION }]);
    this.ctx.effect(() => this.ctx.live.provideState("sessions", () => this.summaries()), "items:state");
  }

  // --- sessions ----------------------------------------------------------------------

  createSession(input: { projectId: string; label: string; source: SourceRef; meta?: Record<string, unknown> }): Session {
    if (!this.ctx.projects.get(input.projectId)) {
      throw new HttpError(404, "project not found");
    }
    const sessionId = shortId();
    const meta = input.meta === undefined ? {} : input.meta;
    this.ctx.db.database
      .query("INSERT INTO sessions (id, project_id, label, source, producing, created, meta) VALUES (?, ?, ?, ?, 0, ?, ?)")
      .run(sessionId, input.projectId, input.label, JSON.stringify(input.source), new Date().toISOString(), JSON.stringify(meta));
    const session = this.getSession(sessionId) as Session;
    this.ctx.emit("session/created", session);
    this.ctx.live.notify();
    return session;
  }

  getSession(sessionId: string): Session | undefined {
    const row = this.ctx.db.database
      .query("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId) as SessionRow | null;
    if (row === null) {
      return undefined;
    }
    return rowToSession(row);
  }

  listSessions(projectId?: string): Session[] {
    if (projectId === undefined) {
      const rows = this.ctx.db.database.query("SELECT * FROM sessions ORDER BY created, rowid").all() as SessionRow[];
      return rows.map(rowToSession);
    }
    const rows = this.ctx.db.database
      .query("SELECT * FROM sessions WHERE project_id = ? ORDER BY created, rowid")
      .all(projectId) as SessionRow[];
    return rows.map(rowToSession);
  }

  updateSession(sessionId: string, patch: Partial<Pick<Session, "label" | "producing" | "meta">>): Session {
    const existing = this.requireSession(sessionId);
    const label = patch.label === undefined ? existing.label : patch.label;
    const producing = patch.producing === undefined ? existing.producing : patch.producing;
    const meta = patch.meta === undefined ? existing.meta : patch.meta;
    this.ctx.db.database
      .query("UPDATE sessions SET label = ?, producing = ?, meta = ? WHERE id = ?")
      .run(label, integerFlag(producing), JSON.stringify(meta), sessionId);
    this.ctx.live.notify();
    return this.requireSession(sessionId);
  }

  removeSession(sessionId: string): void {
    this.requireSession(sessionId);
    this.ctx.db.database.query("DELETE FROM sessions WHERE id = ?").run(sessionId);
    this.ctx.emit("session/removed", sessionId);
    this.ctx.live.notify();
  }

  async status(sessionId: string): Promise<SessionStatus> {
    const session = this.requireSession(sessionId);
    const counts = this.ctx.db.database
      .query(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(embedded), 0) AS embedded,
                COALESCE(SUM(status = 'labeled'), 0) AS labeled,
                COALESCE(SUM(status = 'skipped'), 0) AS skipped
         FROM items WHERE session_id = ?`,
      )
      .get(sessionId) as { total: number; embedded: number; labeled: number; skipped: number };
    const training = await this.trainingState(session);
    return { session, ...counts, ...training };
  }

  summaries(projectId?: string): SessionSummary[] {
    const filter = projectId === undefined ? "" : "WHERE s.project_id = ?";
    const parameters = projectId === undefined ? [] : [projectId];
    const rows = this.ctx.db.database
      .query(
        `SELECT s.id, s.label, s.project_id, s.producing,
                COUNT(i.id) AS total,
                COALESCE(SUM(i.status = 'labeled'), 0) AS labeled,
                COALESCE(SUM(i.status = 'skipped'), 0) AS skipped
         FROM sessions s LEFT JOIN items i ON i.session_id = s.id
         ${filter}
         GROUP BY s.id ORDER BY s.created, s.rowid`,
      )
      .all(...parameters) as SummaryRow[];
    return rows.map(rowToSummary);
  }

  // --- items -------------------------------------------------------------------------

  append(sessionId: string, items: NewItem[]): Item[] {
    this.requireSession(sessionId);
    const added = this.ctx.db.transaction(() => this.insertAll(sessionId, items));
    if (added.length > 0) {
      this.changed(sessionId);
    }
    return added;
  }

  get(itemId: string): Item | undefined {
    const row = this.ctx.db.database.query("SELECT * FROM items WHERE id = ?").get(itemId) as ItemRow | null;
    if (row === null) {
      return undefined;
    }
    return rowToItem(row);
  }

  list(sessionId: string, filter: { status?: ItemStatus; embedded?: boolean } = {}): Item[] {
    const conditions = ["session_id = ?"];
    const parameters: (string | number)[] = [sessionId];
    if (filter.status !== undefined) {
      conditions.push("status = ?");
      parameters.push(filter.status);
    }
    if (filter.embedded !== undefined) {
      conditions.push("embedded = ?");
      parameters.push(integerFlag(filter.embedded));
    }
    const rows = this.ctx.db.database
      .query(`SELECT * FROM items WHERE ${conditions.join(" AND ")} ORDER BY idx`)
      .all(...parameters) as ItemRow[];
    return rows.map(rowToItem);
  }

  setAnnotations(itemId: string, annotations: Annotation[], status: ItemStatus): Item {
    const existing = this.requireItem(itemId);
    this.ctx.db.database
      .query("UPDATE items SET annotations = ?, status = ? WHERE id = ?")
      .run(JSON.stringify(annotations), status, itemId);
    this.changed(existing.sessionId);
    return this.requireItem(itemId);
  }

  propose(itemId: string, annotations: Annotation[]): Item {
    const existing = this.requireItem(itemId);
    if (existing.status !== "pending") {
      return existing;
    }
    this.ctx.db.database.query("UPDATE items SET annotations = ? WHERE id = ?").run(JSON.stringify(annotations), itemId);
    this.changed(existing.sessionId);
    return this.requireItem(itemId);
  }

  setEmbedded(itemIds: string[], embedded: boolean): void {
    const touchedSessions = new Set<string>();
    this.ctx.db.transaction(() => {
      for (const itemId of itemIds) {
        this.ctx.db.database.query("UPDATE items SET embedded = ? WHERE id = ?").run(integerFlag(embedded), itemId);
        const item = this.get(itemId);
        if (item) {
          touchedSessions.add(item.sessionId);
        }
      }
    });
    for (const sessionId of touchedSessions) {
      this.changed(sessionId);
    }
  }

  setSpan(itemId: string, span: Span): Item {
    const existing = this.requireItem(itemId);
    const baseRef = parseSpanRef(existing.ref).ref;
    try {
      this.ctx.db.database
        .query("UPDATE items SET ref = ?, span_start = ?, span_end = ?, embedded = 0 WHERE id = ?")
        .run(spanRef(baseRef, span), span.start, span.end, itemId);
    } catch (error) {
      throw new HttpError(409, "an item with that span already exists in the session");
    }
    this.changed(existing.sessionId);
    return this.requireItem(itemId);
  }

  remove(itemId: string): void {
    const existing = this.requireItem(itemId);
    this.ctx.db.database.query("DELETE FROM items WHERE id = ?").run(itemId);
    this.changed(existing.sessionId);
  }

  compact(sessionId: string): void {
    this.requireSession(sessionId);
    this.ctx.db.transaction(() => this.renumber(sessionId));
    this.changed(sessionId);
  }

  labeledInProject(projectId: string): Item[] {
    const rows = this.ctx.db.database
      .query(
        `SELECT i.* FROM items i JOIN sessions s ON s.id = i.session_id
         WHERE s.project_id = ? AND i.status = 'labeled'
         ORDER BY s.created, s.rowid, i.idx`,
      )
      .all(projectId) as ItemRow[];
    return rows.map(rowToItem);
  }

  // --- internals ---------------------------------------------------------------------

  private insertAll(sessionId: string, items: NewItem[]): Item[] {
    const added: Item[] = [];
    let nextIndex = this.maxIndex(sessionId) + 1;
    for (const newItem of items) {
      const itemId = this.insertOne(sessionId, nextIndex, newItem);
      if (itemId === undefined) {
        continue;
      }
      nextIndex += 1;
      added.push(this.requireItem(itemId));
    }
    return added;
  }

  /** Returns the new id, or undefined when the ref already exists in the session. */
  private insertOne(sessionId: string, index: number, newItem: NewItem): string | undefined {
    const itemId = shortId();
    const meta = newItem.meta === undefined ? {} : newItem.meta;
    const spanStart = newItem.span === undefined ? null : newItem.span.start;
    const spanEnd = newItem.span === undefined ? null : newItem.span.end;
    const result = this.ctx.db.database
      .query(
        `INSERT INTO items (id, session_id, idx, ref, media_kind, span_start, span_end, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id, ref) DO NOTHING`,
      )
      .run(itemId, sessionId, index, storedRef(newItem), newItem.mediaKind, spanStart, spanEnd, JSON.stringify(meta));
    if (result.changes === 0) {
      return undefined;
    }
    return itemId;
  }

  /** Parks every idx above the current maximum first so UNIQUE(session_id, idx) never collides. */
  private renumber(sessionId: string): void {
    const parkOffset = this.maxIndex(sessionId) + 1;
    const database = this.ctx.db.database;
    database.query("UPDATE items SET idx = idx + ? WHERE session_id = ?").run(parkOffset, sessionId);
    const rows = database
      .query("SELECT id FROM items WHERE session_id = ? ORDER BY idx")
      .all(sessionId) as { id: string }[];
    rows.forEach((row, position) => {
      database.query("UPDATE items SET idx = ? WHERE id = ?").run(position, row.id);
    });
  }

  private maxIndex(sessionId: string): number {
    const row = this.ctx.db.database
      .query("SELECT COALESCE(MAX(idx), -1) AS maxIndex FROM items WHERE session_id = ?")
      .get(sessionId) as { maxIndex: number };
    return row.maxIndex;
  }

  private async trainingState(session: Session): Promise<{ modelTrained: boolean; poolSize: number }> {
    const project = this.ctx.projects.get(session.projectId) as Project;
    const provider = this.ctx.models.get(project.config.model);
    if (!provider) {
      return { modelTrained: false, poolSize: 0 };
    }
    try {
      const state = await provider.status(project.id, classNamesOf(project.config));
      return { modelTrained: state.trained, poolSize: state.poolSize };
    } catch (error) {
      return { modelTrained: false, poolSize: 0 };
    }
  }

  private requireSession(sessionId: string): Session {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new HttpError(404, "session not found");
    }
    return session;
  }

  private requireItem(itemId: string): Item {
    const item = this.get(itemId);
    if (!item) {
      throw new HttpError(404, "item not found");
    }
    return item;
  }

  private changed(sessionId: string): void {
    this.ctx.emit("items/changed", sessionId);
    this.ctx.live.notify();
  }
}

export default ItemsCore;
