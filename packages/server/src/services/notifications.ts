import { Service } from "@neoworks/extension-system";
import type { Context } from "@neoworks/extension-system";
import { HttpError } from "@atlas/contracts/server";
import type { NotificationLevel, NotificationView } from "@atlas/contracts";
import type { NotificationInput, NotificationsService } from "@atlas/contracts/server";

interface NotificationRow {
  id: string;
  key: string | null;
  message: string;
  session_id: string | null;
  level: NotificationLevel;
  created: string;
  updated: string;
}

const NOTIFICATIONS_MIGRATION = `
  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    key TEXT,
    message TEXT NOT NULL,
    session_id TEXT,
    level TEXT NOT NULL,
    created TEXT NOT NULL,
    updated TEXT NOT NULL
  );
  CREATE UNIQUE INDEX notifications_key ON notifications (key) WHERE key IS NOT NULL;
`;

function rowToView(row: NotificationRow): NotificationView {
  return {
    id: row.id,
    key: row.key === null ? undefined : row.key,
    message: row.message,
    sessionId: row.session_id === null ? undefined : row.session_id,
    level: row.level,
    created: row.created,
  };
}

function optionalText(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  return value;
}

function levelOf(input: NotificationInput): NotificationLevel {
  if (input.level === undefined) {
    return "info";
  }
  return input.level;
}

export class NotificationsCore extends Service implements NotificationsService {
  static inject = ["db", "live", "http"];

  private sequence = 0;

  constructor(ctx: Context) {
    super(ctx, "notifications");
    ctx.db.migrate("notifications", [{ version: 1, sql: NOTIFICATIONS_MIGRATION }]);
    this.ctx.effect(() => this.ctx.live.provideState("notifications", () => this.list()), "notifications:state");
    this.registerRoutes();
  }

  persist(input: NotificationInput): NotificationView {
    const existing = this.findByKey(input.key);
    if (existing) {
      return this.replace(existing, input);
    }
    return this.insert(input);
  }

  toast(input: NotificationInput): void {
    this.ctx.live.broadcast("toast", {
      toast: {
        id: this.nextId(),
        message: input.message,
        sessionId: input.sessionId,
        level: levelOf(input),
      },
    });
  }

  list(): NotificationView[] {
    const rows = this.ctx.db.database
      .query("SELECT * FROM notifications ORDER BY updated DESC, rowid DESC")
      .all() as NotificationRow[];
    return rows.map(rowToView);
  }

  dismiss(id: string): void {
    this.ctx.db.database.query("DELETE FROM notifications WHERE id = ?").run(id);
    this.ctx.live.notify();
  }

  clear(): void {
    this.ctx.db.database.query("DELETE FROM notifications").run();
    this.ctx.live.notify();
  }

  private nextId(): string {
    this.sequence += 1;
    return `note-${Date.now()}-${this.sequence}`;
  }

  private findByKey(key: string | undefined): NotificationRow | undefined {
    if (key === undefined) {
      return undefined;
    }
    const row = this.ctx.db.database
      .query("SELECT * FROM notifications WHERE key = ?")
      .get(key) as NotificationRow | null;
    if (row === null) {
      return undefined;
    }
    return row;
  }

  private replace(existing: NotificationRow, input: NotificationInput): NotificationView {
    const updated = new Date().toISOString();
    this.ctx.db.database
      .query("UPDATE notifications SET message = ?, level = ?, session_id = ?, updated = ? WHERE id = ?")
      .run(input.message, levelOf(input), optionalText(input.sessionId), updated, existing.id);
    this.ctx.live.notify();
    return rowToView({
      ...existing,
      message: input.message,
      level: levelOf(input),
      session_id: optionalText(input.sessionId),
      updated,
    });
  }

  private insert(input: NotificationInput): NotificationView {
    const now = new Date().toISOString();
    const row: NotificationRow = {
      id: this.nextId(),
      key: optionalText(input.key),
      message: input.message,
      session_id: optionalText(input.sessionId),
      level: levelOf(input),
      created: now,
      updated: now,
    };
    this.ctx.db.database
      .query("INSERT INTO notifications (id, key, message, session_id, level, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(row.id, row.key, row.message, row.session_id, row.level, row.created, row.updated);
    this.ctx.live.notify();
    return rowToView(row);
  }

  private registerRoutes(): void {
    this.ctx.effect(() => this.ctx.http.route("GET", "/api/notifications", () => this.list()), "route:GET /api/notifications");
    this.ctx.effect(() => this.ctx.http.route("POST", "/api/notifications/dismiss", async (request) => {
      const body = (await request.json()) as { id?: unknown };
      if (typeof body.id !== "string") {
        throw new HttpError(400, "id is required");
      }
      this.dismiss(body.id);
    }), "route:POST /api/notifications/dismiss");
    this.ctx.effect(() => this.ctx.http.route("POST", "/api/notifications/clear", () => this.clear()), "route:POST /api/notifications/clear");
  }
}

export default NotificationsCore;
