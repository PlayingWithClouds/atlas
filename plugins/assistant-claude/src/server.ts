import type { Context } from "@neoworks/extension-system";
import type {} from "@atlas/contracts/server";
import { createClaudeBackend } from "./backend";
import { resolveConfig } from "./config";
import type { ClaudeConfig } from "./config";
import { ProcessTracker, spawnWithBun } from "./runner";
import type { SpawnClaude } from "./runner";

/** Test seam: lets tests replace the process spawner without touching config. */
export interface ClaudePluginOptions {
  spawn?: SpawnClaude;
}

export function createClaudePlugin(options: ClaudePluginOptions = {}) {
  return {
    name: "assistant-claude",
    inject: ["assistantBackends", "http", "workspace"],
    apply(ctx: Context, config: ClaudeConfig = {}) {
      const resolved = resolveConfig(config);
      const tracker = new ProcessTracker();
      const spawn = options.spawn || spawnWithBun;
      const backend = createClaudeBackend(
        { config: resolved, spawn, tracker },
        {
          workspaceDirectory: ctx.workspace.directory,
          mcpUrl: () => `http://127.0.0.1:${ctx.http.port}/api/mcp`,
        },
      );
      // Requests own their processes; unloading kills whatever is still running.
      ctx.effect(() => () => tracker.killAll(), "claude:processes");
      ctx.effect(() => ctx.assistantBackends.register(backend), "backend:claude");
    },
  };
}

export default createClaudePlugin();
