import type { Context } from "@neoworks/extension-system";
import { handleGet, handlePost } from "./protocol";
import type { McpConfig } from "./protocol";

const MCP_PATHS = ["/api/mcp", "/api/mcp/"];

export default {
  name: "mcp",
  inject: ["http", "tools", "workspace"],
  apply(ctx: Context, config: McpConfig = {}) {
    const allowWrites = config.allowWrites === true;
    for (const path of MCP_PATHS) {
      ctx.effect(() => ctx.http.route("POST", path, (request) => handlePost(ctx, allowWrites, request)), `route:POST ${path}`);
      ctx.effect(() => ctx.http.route("GET", path, () => handleGet()), `route:GET ${path}`);
    }
  },
};
