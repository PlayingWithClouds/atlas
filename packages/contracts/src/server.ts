/**
 * Host services a server-side plugin may inject. Each interface below is provided under a
 * key on the extension-system `Context`; plugins list the keys they need in `inject`.
 *
 * Anything a plugin registers must be registered through `ctx.effect` so it is withdrawn
 * when the plugin unloads:
 *
 *   ctx.effect(() => ctx.http.route("GET", "/api/hello", () => ({ hello: "world" })))
 */

import type { Database } from "bun:sqlite";
// Loads the kernel module into the program so the `declare module` augmentation below can find it.
import type {} from "@neoworks/extension-system";
import type { LiveEvent, NotificationLevel, NotificationView, PluginView, WorkspaceConfig } from "./index";

export type Dispose = () => void;

export interface WorkspaceService {
  /** Absolute workspace directory. Holds atlas.json, store.db and cache/. */
  readonly directory: string;
  readonly cacheDirectory: string;
  /** Cache directory reserved for one plugin; created on first call. */
  pluginCacheDirectory(pluginName: string): string;
  /** Read from disk on every call, so hand edits apply to the next call. */
  config(): WorkspaceConfig;
  /** Persists a modified config atomically (tmp file + rename) and emits `workspace/config`. */
  saveConfig(config: WorkspaceConfig): void;
}

export interface Migration {
  /** Monotonic within its namespace; applied in order, never edited once released. */
  version: number;
  sql: string;
}

export interface DbService {
  readonly database: Database;
  /** Applies pending migrations for a namespace (usually the plugin name). Idempotent. */
  migrate(namespace: string, migrations: Migration[]): void;
  transaction<T>(run: () => T): T;
}

export type RouteParams = Record<string, string>;

/**
 * Returning a plain value serializes it as JSON. Throwing `HttpError` sets the status and
 * answers `{detail}`; throwing `ValidationFailure` answers 422 `{errors}`; any other throw
 * becomes 500 `{detail}`.
 */
export type RouteHandler = (request: Request, params: RouteParams) => unknown | Promise<unknown>;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** An invalid write: answered as 422 `{ errors: string[] }`. */
export class ValidationFailure extends HttpError {
  constructor(public readonly errors: string[]) {
    super(422, errors.join("; "));
  }
}

export interface HttpService {
  /** `pattern` uses `:name` segments and a trailing `*` wildcard, e.g. `/api/items/:id`. */
  route(method: string, pattern: string, handler: RouteHandler): Dispose;
  readonly port: number;
}

export interface LiveService {
  /** Adds a keyed slice to the `state` snapshot pushed to every client. */
  provideState(key: string, read: () => unknown): Dispose;
  /** Coalesced: schedules a fresh `state` push to every client. */
  notify(): void;
  /** Sends `{type, ...payload}` to every client. */
  broadcast(type: string, payload: Record<string, unknown>): void;
}

export interface NotificationInput {
  /** Same key replaces the earlier entry, so long-running work keeps one tray line. */
  key?: string;
  message: string;
  level?: NotificationLevel;
}

export interface NotificationsService {
  persist(input: NotificationInput): NotificationView;
  toast(input: NotificationInput): void;
  list(): NotificationView[];
  dismiss(id: string): void;
  clear(): void;
}

export interface PluginsService {
  list(): PluginView[];
  /** Re-reads atlas.json and loads, unloads or reconfigures plugins to match. */
  reload(): Promise<void>;
}

export interface StoreService {
  /** Called after every committed change to items, suggestions, annotations, taxonomy or projects. */
  subscribe(listener: (event: LiveEvent) => void): Dispose;
}

declare module "@neoworks/extension-system" {
  interface Context {
    workspace: WorkspaceService;
    db: DbService;
    http: HttpService;
    live: LiveService;
    notifications: NotificationsService;
    plugins: PluginsService;
    store: StoreService;
  }

  interface Events {
    "workspace/config"(config: WorkspaceConfig): void;
  }
}
