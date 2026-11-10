/**
 * Shared shapes used by the server, the web app and every plugin.
 *
 * The data schema (taxonomy, media, annotations, suggestions) lives in `./schema` and is
 * specified in docs/schema.md; its rules are checked by the pure functions in `./validate`.
 */

export * from "./schema";
export * from "./validate";

import type { WebhookConfig } from "./schema";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type NotificationLevel = "info" | "success" | "error";

export interface NotificationView {
  id: string;
  key?: string;
  message: string;
  level: NotificationLevel;
  created: string;
}

export interface PluginView {
  name: string;
  state: string;
  error?: string;
  /** Labels of what the plugin currently provides or registers, for diagnostics. */
  contributions: string[];
}

// --- workspace ---------------------------------------------------------------------------

export interface WorkspaceConfig {
  title: string;
  plugins: PluginEntry[];
  /** Adapters notified of changes; see docs/schema.md "Webhooks". */
  webhooks: WebhookConfig[];
  /**
   * API tokens for adapters on other machines. Requests from this machine are always
   * trusted; others need `Authorization: Bearer <token>` once any token is configured.
   */
  tokens: { name: string; token: string }[];
  /** Free-form settings owned by plugins, keyed by plugin name. */
  settings: Record<string, Record<string, unknown>>;
}

// --- plugin manifest ---------------------------------------------------------------------

/** The `atlas` field of a plugin's package.json. */
export interface AtlasPluginManifest {
  /** Module whose default export is the server-side extension-system plugin. */
  server?: string;
  /** Module whose default export is the web-side extension-system plugin. */
  web?: string;
}

/** One entry in a workspace's `atlas.json` plugin list. */
export interface PluginEntry {
  /** Package name; resolved from `path` when given, else from node_modules. */
  package: string;
  path?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}
