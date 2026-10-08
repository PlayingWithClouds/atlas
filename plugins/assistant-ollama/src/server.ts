import type { Context } from "@neoworks/extension-system";
import type { AssistantBackend } from "@atlas/plugin-assistant/types";
import { OllamaClient } from "./client";
import { resolveConfig } from "./config";
import type { OllamaConfig } from "./config";
import { runTurn } from "./loop";

export const BACKEND_ID = "ollama";

export default {
  name: "assistant-ollama",
  inject: ["assistantBackends", "tools"],
  apply(ctx: Context, config: OllamaConfig = {}) {
    const resolved = resolveConfig(config);
    const dependencies = { ctx, client: new OllamaClient(resolved.url), config: resolved };
    const backend: AssistantBackend = {
      id: BACKEND_ID,
      label: `Ollama (${resolved.model})`,
      async chat(turn, emit, signal) {
        const produced = await runTurn(dependencies, turn, emit, signal);
        // The next turn replays these, so the model keeps the tool results it already read.
        emit({ kind: "done", content: JSON.stringify(produced) });
      },
    };
    ctx.effect(() => ctx.assistantBackends.register(backend), "backend:ollama");
  },
};
