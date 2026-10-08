import { Service } from "@neoworks/extension-system";
import type { Context } from "@neoworks/extension-system";
import { HttpError } from "@atlas/contracts/server";
import type { JobState, JobView } from "@atlas/contracts";
import type { JobHandle, JobSpec, JobsService } from "@atlas/contracts/server";

const MAX_CONCURRENT_JOBS = 3;
const PROGRESS_PERSIST_INTERVAL_MS = 400;
const RECENT_JOB_LIMIT = 50;

interface JobRow {
  id: string;
  type: string;
  session_id: string | null;
  phase: string;
  done: number;
  total: number;
  state: JobState;
  error: string;
  extra: string;
  created: number;
  updated: number;
}

const JOBS_MIGRATION = `
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    session_id TEXT,
    phase TEXT NOT NULL DEFAULT '',
    done INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL,
    error TEXT NOT NULL DEFAULT '',
    extra TEXT NOT NULL DEFAULT '{}',
    created REAL NOT NULL,
    updated REAL NOT NULL
  );
  CREATE INDEX jobs_session ON jobs (session_id);
`;

function nowSeconds(): number {
  return Date.now() / 1000;
}

function rowToView(row: JobRow): JobView {
  return {
    id: row.id,
    type: row.type,
    sessionId: row.session_id === null ? undefined : row.session_id,
    phase: row.phase,
    done: row.done,
    total: row.total,
    state: row.state,
    error: row.error,
    extra: JSON.parse(row.extra),
    created: row.created,
    updated: row.updated,
  };
}

export class JobsCore extends Service implements JobsService {
  static inject = ["db", "live", "http"];

  private readonly activeViews = new Map<string, JobView>();
  private readonly lastPersistedAt = new Map<string, number>();
  private readonly abortController = new AbortController();
  private readonly waitingForSlot: (() => void)[] = [];
  private runningCount = 0;
  private sequence = 0;
  private disposed = false;

  constructor(ctx: Context) {
    super(ctx, "jobs");
    ctx.db.migrate("jobs", [{ version: 1, sql: JOBS_MIGRATION }]);
    this.markInterrupted();
    this.ctx.effect(() => this.ctx.live.provideState("jobs", () => this.stateSlice()), "jobs:state");
    this.ctx.effect(() => () => this.shutdown(), "jobs:shutdown");
    this.registerRoutes();
  }

  submit(spec: JobSpec, run: (job: JobHandle) => Promise<void>): JobView {
    const now = nowSeconds();
    this.sequence += 1;
    const view: JobView = {
      id: `job-${Date.now()}-${this.sequence}`,
      type: spec.type,
      sessionId: spec.sessionId,
      phase: "queued",
      done: 0,
      total: spec.total === undefined ? 0 : spec.total,
      state: "running",
      error: "",
      extra: spec.extra === undefined ? {} : { ...spec.extra },
      created: now,
      updated: now,
    };
    this.insert(view);
    this.activeViews.set(view.id, view);
    this.ctx.live.notify();
    void this.execute(view, run);
    return { ...view };
  }

  isRunning(type: string, sessionId?: string): boolean {
    for (const view of this.activeViews.values()) {
      if (view.type !== type) {
        continue;
      }
      if (sessionId === undefined || view.sessionId === sessionId) {
        return true;
      }
    }
    return false;
  }

  list(filter?: { sessionId?: string; activeOnly?: boolean }): JobView[] {
    const conditions: string[] = [];
    const parameters: string[] = [];
    if (filter && filter.sessionId !== undefined) {
      conditions.push("session_id = ?");
      parameters.push(filter.sessionId);
    }
    if (filter && filter.activeOnly) {
      conditions.push("state = 'running'");
    }
    return this.select(conditions, parameters);
  }

  get(id: string): JobView | undefined {
    const active = this.activeViews.get(id);
    if (active) {
      return { ...active };
    }
    const row = this.ctx.db.database.query("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | null;
    if (row === null) {
      return undefined;
    }
    return rowToView(row);
  }

  private select(conditions: string[], parameters: string[], limit = -1): JobView[] {
    let where = "";
    if (conditions.length > 0) {
      where = `WHERE ${conditions.join(" AND ")}`;
    }
    const rows = this.ctx.db.database
      .query(`SELECT * FROM jobs ${where} ORDER BY rowid DESC LIMIT ${limit}`)
      .all(...parameters) as JobRow[];
    return rows.map((row) => this.overlayActive(rowToView(row)));
  }

  private overlayActive(view: JobView): JobView {
    const active = this.activeViews.get(view.id);
    if (active) {
      return { ...active };
    }
    return view;
  }

  private stateSlice(): JobView[] {
    const active = this.select(["state = 'running'"], []);
    const recent = this.select(["state != 'running'"], [], RECENT_JOB_LIMIT);
    return [...active, ...recent];
  }

  private markInterrupted(): void {
    this.ctx.db.database
      .query("UPDATE jobs SET state = 'interrupted', updated = ? WHERE state = 'running'")
      .run(nowSeconds());
  }

  private insert(view: JobView): void {
    this.ctx.db.database
      .query(
        `INSERT INTO jobs (id, type, session_id, phase, done, total, state, error, extra, created, updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        view.id,
        view.type,
        view.sessionId === undefined ? null : view.sessionId,
        view.phase,
        view.done,
        view.total,
        view.state,
        view.error,
        JSON.stringify(view.extra),
        view.created,
        view.updated,
      );
    this.lastPersistedAt.set(view.id, Date.now());
  }

  private persist(view: JobView): void {
    if (this.disposed) {
      return;
    }
    this.ctx.db.database
      .query("UPDATE jobs SET phase = ?, done = ?, total = ?, state = ?, error = ?, extra = ?, updated = ? WHERE id = ?")
      .run(view.phase, view.done, view.total, view.state, view.error, JSON.stringify(view.extra), view.updated, view.id);
    this.lastPersistedAt.set(view.id, Date.now());
  }

  private persistThrottled(view: JobView): void {
    const lastPersisted = this.lastPersistedAt.get(view.id);
    if (lastPersisted !== undefined && Date.now() - lastPersisted < PROGRESS_PERSIST_INTERVAL_MS) {
      return;
    }
    this.persist(view);
  }

  private touch(view: JobView, throttled: boolean): void {
    if (this.disposed) {
      return;
    }
    view.updated = nowSeconds();
    if (throttled) {
      this.persistThrottled(view);
    } else {
      this.persist(view);
    }
    this.ctx.live.notify();
  }

  private createHandle(view: JobView): JobHandle {
    return {
      id: view.id,
      signal: this.abortController.signal,
      progress: (done, total) => {
        view.done = done;
        if (total !== undefined) {
          view.total = total;
        }
        this.touch(view, true);
      },
      phase: (phase) => {
        view.phase = phase;
        this.touch(view, true);
      },
      setExtra: (extra) => {
        view.extra = { ...extra };
        this.touch(view, true);
      },
    };
  }

  private async execute(view: JobView, run: (job: JobHandle) => Promise<void>): Promise<void> {
    await this.acquireSlot();
    if (this.disposed) {
      return;
    }
    try {
      view.phase = "running";
      this.touch(view, false);
      await run(this.createHandle(view));
      this.finish(view, "done", "");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.finish(view, "error", message);
    } finally {
      this.releaseSlot();
    }
  }

  private finish(view: JobView, state: JobState, errorMessage: string): void {
    if (this.disposed) {
      return;
    }
    view.state = state;
    view.error = errorMessage;
    this.touch(view, false);
    this.activeViews.delete(view.id);
    this.lastPersistedAt.delete(view.id);
    this.ctx.live.notify();
  }

  private acquireSlot(): Promise<void> {
    if (this.runningCount < MAX_CONCURRENT_JOBS) {
      this.runningCount += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waitingForSlot.push(resolve));
  }

  private releaseSlot(): void {
    const next = this.waitingForSlot.shift();
    if (next) {
      next();
      return;
    }
    this.runningCount -= 1;
  }

  private shutdown(): void {
    this.disposed = true;
    this.abortController.abort();
    for (const resolve of this.waitingForSlot) {
      resolve();
    }
    this.waitingForSlot.length = 0;
  }

  private registerRoutes(): void {
    this.ctx.effect(() => this.ctx.http.route("GET", "/api/jobs", (request) => {
      const query = new URL(request.url).searchParams;
      const sessionId = query.get("sessionId");
      return this.list({
        sessionId: sessionId === null ? undefined : sessionId,
        activeOnly: query.get("active") === "true",
      });
    }), "route:GET /api/jobs");
    this.ctx.effect(() => this.ctx.http.route("GET", "/api/jobs/:id", (_request, params) => {
      const job = this.get(params.id);
      if (!job) {
        throw new HttpError(404, "job not found");
      }
      return job;
    }), "route:GET /api/jobs/:id");
  }
}

export default JobsCore;
