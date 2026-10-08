import { Service } from "@neoworks/extension-system";
import type { Context } from "@neoworks/extension-system";
import type { Dispose, Tool, ToolContent, ToolsService } from "@atlas/contracts/server";

type ToolContext = { projectId?: string; sessionId?: string };
type ToolOutcome = { content: ToolContent[]; isError: boolean };

function failure(message: string): ToolOutcome {
  return { content: [{ type: "text", text: message }], isError: true };
}

function requiredKeys(tool: Tool): string[] {
  const required = tool.inputSchema.required;
  if (!Array.isArray(required)) {
    return [];
  }
  return required.filter((key): key is string => typeof key === "string");
}

function missingArguments(tool: Tool, args: Record<string, unknown>): string[] {
  return requiredKeys(tool).filter((key) => args[key] === undefined || args[key] === null);
}

export class ToolsCore extends Service implements ToolsService {
  private readonly tools = new Map<string, Tool>();

  constructor(ctx: Context) {
    super(ctx, "tools");
    this.ctx.effect(() => () => this.tools.clear(), "tools:registry");
  }

  register(tool: Tool): Dispose {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
    return () => {
      if (this.tools.get(tool.name) === tool) {
        this.tools.delete(tool.name);
      }
    };
  }

  list(): Tool[] {
    return [...this.tools.values()].sort((first, second) => first.name.localeCompare(second.name));
  }

  /** Failures are returned in-band so the model sees them and can correct itself. */
  async call(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      return failure(`unknown tool "${name}"`);
    }
    const missing = missingArguments(tool, args);
    if (missing.length > 0) {
      return failure(`missing required argument(s): ${missing.join(", ")}`);
    }
    try {
      return { content: await tool.run(args, context), isError: false };
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
  }
}

export default ToolsCore;
