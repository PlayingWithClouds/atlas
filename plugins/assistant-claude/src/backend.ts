import fs from "node:fs";
import path from "node:path";
import type { AssistantBackend, AssistantEmit, AssistantMessage, AssistantTurn } from "@atlas/plugin-assistant/types";
import { latestUserMessage } from "@atlas/plugin-assistant/types";
import { runClaudeOnce } from "./runner";
import type { RunDependencies, RunResult } from "./runner";

export const BACKEND_ID = "claude";
export const AGENT_DIRECTORY_NAME = "agent";

export interface BackendEnvironment {
  /** Absolute workspace directory. */
  workspaceDirectory: string;
  /** Read per turn: the host's port is only known once it is serving. */
  mcpUrl(): string;
}

type TurnLaunch = { mcpUrl: string; workspaceDirectory: string; cwd: string };

function agentDirectoryOf(workspaceDirectory: string): string {
  const directory = path.join(workspaceDirectory, AGENT_DIRECTORY_NAME);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

/**
 * A conversation the CLI no longer knows about (its state cleared, or a session from another
 * machine) fails on --resume alone. Starting fresh beats dead-ending, as long as nothing has been
 * shown yet.
 */
async function runWithFreshRetry(
  dependencies: RunDependencies,
  turn: AssistantTurn,
  prompt: string,
  launch: TurnLaunch,
  emit: AssistantEmit,
  signal: AbortSignal,
): Promise<RunResult> {
  const first = await runClaudeOnce(dependencies, turn, prompt, launch, emit, signal);
  const resumed = turn.session !== undefined && turn.session !== "";
  if (first.failure === undefined || !resumed || first.outcome.events > 0 || signal.aborted) {
    return first;
  }
  return runClaudeOnce(dependencies, { ...turn, session: undefined }, prompt, launch, emit, signal);
}

function answerMessages(text: string): AssistantMessage[] {
  if (text === "") {
    return [];
  }
  return [{ role: "assistant", content: text }];
}

function timeoutMessage(timeoutSeconds: number): string {
  return `The assistant did not finish within ${timeoutSeconds} seconds and was stopped.`;
}

export function createClaudeBackend(dependencies: RunDependencies, environment: BackendEnvironment): AssistantBackend {
  const { config, tracker } = dependencies;

  return {
    id: BACKEND_ID,
    label: describeBackend(config.model),
    async chat(turn, emit, signal) {
      const prompt = latestUserMessage(turn);
      if (prompt.trim() === "") {
        emit({ kind: "error", content: "there is nothing to answer: the turn carries no user message" });
        return;
      }
      const timeoutSignal = AbortSignal.timeout(config.timeoutSeconds * 1000);
      const combined = AbortSignal.any([signal, timeoutSignal]);
      const launch = {
        mcpUrl: environment.mcpUrl(),
        workspaceDirectory: environment.workspaceDirectory,
        cwd: agentDirectoryOf(environment.workspaceDirectory),
      };
      const result = await runWithFreshRetry(dependencies, turn, prompt, launch, emit, combined);
      if (signal.aborted || tracker.isClosed) {
        return;
      }
      if (timeoutSignal.aborted) {
        emit({ kind: "error", content: timeoutMessage(config.timeoutSeconds) });
        return;
      }
      if (result.failure !== undefined) {
        emit({ kind: "error", content: result.failure });
        return;
      }
      emit({ kind: "done", content: JSON.stringify(answerMessages(result.outcome.text)) });
    },
  };
}

function describeBackend(model: string | undefined): string {
  if (model === undefined) {
    return "Claude Code";
  }
  return `Claude Code (${model})`;
}
