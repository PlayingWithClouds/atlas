import type { AssistantEmit, AssistantTurn } from "@atlas/plugin-assistant/types";
import { buildClaudeArguments } from "./arguments";
import type { LaunchContext } from "./arguments";
import type { ResolvedClaudeConfig } from "./config";
import { readClaudeStream, tail } from "./stream";
import type { Outcome } from "./stream";

/** The slice of a child process the runner needs; `Bun.spawn` results satisfy it. */
export interface ClaudeProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

export interface SpawnOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  stdin: string;
}

export type SpawnClaude = (command: string[], options: SpawnOptions) => ClaudeProcess;

export const spawnWithBun: SpawnClaude = (command, options) =>
  Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdin: new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });

/** Every live CLI process, so unloading the plugin can kill what a request left running. */
export class ProcessTracker {
  private readonly processes = new Set<ClaudeProcess>();
  private closed = false;

  get size(): number {
    return this.processes.size;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  add(process: ClaudeProcess): void {
    this.processes.add(process);
  }

  remove(process: ClaudeProcess): void {
    this.processes.delete(process);
  }

  killAll(): void {
    this.closed = true;
    for (const process of this.processes) {
      process.kill();
    }
    this.processes.clear();
  }
}

export interface RunDependencies {
  config: ResolvedClaudeConfig;
  spawn: SpawnClaude;
  tracker: ProcessTracker;
}

/** What a single CLI run reported, and why it failed if it did. */
export interface RunResult {
  outcome: Outcome;
  failure?: string;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function startProcess(dependencies: RunDependencies, command: string[], options: SpawnOptions): Promise<ClaudeProcess | string> {
  try {
    return dependencies.spawn(command, options);
  } catch (error) {
    return `cannot run ${dependencies.config.binary}: ${messageOf(error)}`;
  }
}

/** Runs the CLI once. The process is killed when `signal` aborts or the plugin unloads. */
export async function runClaudeOnce(
  dependencies: RunDependencies,
  turn: AssistantTurn,
  prompt: string,
  launch: LaunchContext & { cwd: string },
  emit: AssistantEmit,
  signal: AbortSignal,
): Promise<RunResult> {
  const command = buildClaudeArguments(dependencies.config, turn, launch);
  const environment = { ...process.env, ATLAS_WORKSPACE: launch.workspaceDirectory };
  const started = await startProcess(dependencies, command, { cwd: launch.cwd, env: environment, stdin: prompt });
  if (typeof started === "string") {
    return { outcome: { text: "", events: 0 }, failure: started };
  }
  const child = started;
  dependencies.tracker.add(child);
  const kill = () => child.kill();
  signal.addEventListener("abort", kill);
  try {
    return await collect(dependencies, child, emit);
  } finally {
    signal.removeEventListener("abort", kill);
    dependencies.tracker.remove(child);
  }
}

async function collect(dependencies: RunDependencies, child: ClaudeProcess, emit: AssistantEmit): Promise<RunResult> {
  const stderrText = new Response(child.stderr).text();
  const outcome = await readClaudeStream(child.stdout, emit);
  const exitCode = await child.exited;
  if (exitCode === 0) {
    return { outcome };
  }
  return { outcome, failure: `${dependencies.config.binary} failed: exit code ${exitCode}${tail(await stderrText)}` };
}
