import type { Context } from "@neoworks/extension-system";
import { createBackendRegistry } from "./registry";
import { registerRoutes } from "./routes";
import type { AssistantConfig } from "./routes";

export default {
  name: "assistant",
  inject: ["http", "tools"],
  apply(ctx: Context, config: AssistantConfig = {}) {
    ctx.provide("assistantBackends", createBackendRegistry());
    registerRoutes(ctx, config);
  },
};
