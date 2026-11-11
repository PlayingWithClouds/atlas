import { Service } from "@neoworks/extension-system";
import type { Context } from "@neoworks/extension-system";
import { HttpError } from "@atlas/contracts/server";

/** Scopes are `settings` keys in atlas.json, e.g. "web" for the browser app's keys and steps. */
const SCOPE_PATTERN = /^[a-z][a-z0-9_-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireScope(scope: string): string {
  if (!SCOPE_PATTERN.test(scope)) {
    throw new HttpError(404, `no settings scope "${scope}"`);
  }
  return scope;
}

/**
 * Settings shared by every browser on this workspace, kept in atlas.json under `settings.<scope>`:
 * GET /api/settings/:scope reads them ({} when unset), PUT replaces them and tells every open
 * screen (live event `settings`), so a change in one browser shows up in the others.
 */
export class SettingsRoutes extends Service {
  static inject = ["workspace", "http", "live"];

  constructor(ctx: Context) {
    super(ctx, "settingsRoutes");
    this.ctx.effect(() => this.ctx.http.route("GET", "/api/settings/:scope", (_request, params) => this.read(params.scope)), "route:GET /api/settings/:scope");
    this.ctx.effect(
      () => this.ctx.http.route("PUT", "/api/settings/:scope", async (request, params) => this.write(params.scope, await request.json().catch(() => undefined))),
      "route:PUT /api/settings/:scope",
    );
  }

  read(scope: string): Record<string, unknown> {
    const stored = this.ctx.workspace.config().settings[requireScope(scope)];
    if (!isRecord(stored)) {
      return {};
    }
    return stored;
  }

  write(scope: string, body: unknown): Record<string, unknown> {
    requireScope(scope);
    if (!isRecord(body)) {
      throw new HttpError(400, "settings must be a JSON object");
    }
    const config = this.ctx.workspace.config();
    this.ctx.workspace.saveConfig({ ...config, settings: { ...config.settings, [scope]: body } });
    this.ctx.live.broadcast("settings", { scope });
    return body;
  }
}

export default SettingsRoutes;
