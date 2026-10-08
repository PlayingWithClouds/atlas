import { DEFAULT_CALL_TIMEOUT_MS, JsonRpcClient, RpcTimeoutError } from "./rpc";
import { readLines } from "./lines";
import type { EnvironmentLogger } from "./environment";

export interface LaunchPlan {
  command: string[];
  env: Record<string, string>;
  /** Prefixed to every forwarded stderr line. */
  label: string;
}

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const STDIN_CLOSE_GRACE_MS = 3000;
const STABLE_RUN_MS = 60_000;
const STACK_DUMP_INTERVAL_MS = 60_000;

/**
 * Bun's subprocess pipes can stop delivering a live child's output: the worker answers,
 * but its replies never reach the client. A heartbeat detects that and replaces the child.
 */
export interface HeartbeatOptions {
  intervalMs: number;
  timeoutMs: number;
}

const DEFAULT_HEARTBEAT: HeartbeatOptions = { intervalMs: 10_000, timeoutMs: 5000 };

interface ChildHandle {
  process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  client: JsonRpcClient;
  startedAt: number;
  heartbeat?: ReturnType<typeof setInterval>;
  heartbeatInFlight?: boolean;
}

interface Gate {
  promise: Promise<ChildHandle>;
  open(child: ChildHandle): void;
  fail(error: Error): void;
}

function createGate(): Gate {
  let open!: (child: ChildHandle) => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<ChildHandle>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  // Callers that never await the gate must not trigger unhandled rejections.
  promise.catch(() => undefined);
  return { promise, open, fail };
}

/**
 * Owns one worker process: spawns it, speaks JSON-RPC to it, restarts it after an
 * unexpected exit with exponential backoff, and shuts it down on `stop`.
 */
export class WorkerSupervisor {
  private gate: Gate = createGate();
  private current: ChildHandle | undefined;
  private stopped = false;
  private lastStackDump = 0;
  private restartDelayMs = INITIAL_BACKOFF_MS;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly logger: EnvironmentLogger,
    private readonly heartbeat: HeartbeatOptions = DEFAULT_HEARTBEAT,
  ) {}

  get running(): boolean {
    return this.current !== undefined;
  }

  get processId(): number | undefined {
    return this.current?.process.pid;
  }

  /** Spawns the child and returns the inverse. */
  start(plan: LaunchPlan): () => Promise<void> {
    this.launch(plan);
    return () => this.stop();
  }

  /** Makes every pending and future call fail, e.g. when environment setup failed. */
  fail(error: Error): void {
    this.gate.fail(error);
  }

  async call<T>(method: string, params: Record<string, unknown>, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<T> {
    const child = await this.waitForChild(timeoutMs, method);
    try {
      return await child.client.call<T>(method, params, timeoutMs);
    } catch (error) {
      if (error instanceof RpcTimeoutError) {
        this.dumpStacks(child, method);
      }
      throw error;
    }
  }

  /** A timed-out call usually means a stuck thread; the worker writes every stack to cache/worker-stacks.log on SIGUSR1. */
  private dumpStacks(child: ChildHandle, method: string): void {
    if (Date.now() - this.lastStackDump < STACK_DUMP_INTERVAL_MS || child.process.exitCode !== null) {
      return;
    }
    this.lastStackDump = Date.now();
    this.logger.error(`"${method}" timed out; worker stacks written to cache/worker-stacks.log`);
    child.process.kill("SIGUSR1");
  }

  private waitForChild(timeoutMs: number, method: string): Promise<ChildHandle> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`python worker not running for "${method}"`)), timeoutMs);
    });
    return Promise.race([this.gate.promise, timeout]).finally(() => clearTimeout(timer));
  }

  private launch(plan: LaunchPlan): void {
    if (this.stopped) {
      return;
    }
    const childProcess = Bun.spawn(plan.command, {
      env: plan.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const client = new JsonRpcClient((line) => {
      childProcess.stdin.write(line + "\n");
      childProcess.stdin.flush();
    });
    const child: ChildHandle = { process: childProcess, client, startedAt: Date.now() };
    this.current = child;
    this.gate.open(child);
    this.forwardOutput(child, plan);
    child.heartbeat = setInterval(() => this.checkHeartbeat(child, plan), this.heartbeat.intervalMs);
    childProcess.exited.then((exitCode) => this.handleExit(child, plan, exitCode));
  }

  private forwardOutput(child: ChildHandle, plan: LaunchPlan): void {
    const stdout = child.process.stdout;
    const stderr = child.process.stderr;
    readLines(stdout, (line) => child.client.handleLine(line)).catch((error: Error) => {
      this.logger.error(`[${plan.label}] reading worker output failed: ${error.message}`);
    });
    readLines(stderr, (line) => this.logger.info(`[${plan.label}] ${line}`)).catch(() => undefined);
  }

  private async checkHeartbeat(child: ChildHandle, plan: LaunchPlan): Promise<void> {
    if (child.heartbeatInFlight) {
      return;
    }
    child.heartbeatInFlight = true;
    try {
      await child.client.call("ping", {}, this.heartbeat.timeoutMs);
    } catch (error) {
      if (error instanceof RpcTimeoutError) {
        this.replaceUnresponsive(child, plan);
      }
    } finally {
      child.heartbeatInFlight = false;
    }
  }

  /** Does not wait for `exited`: the same stall can keep Bun from noticing the exit. */
  private replaceUnresponsive(child: ChildHandle, plan: LaunchPlan): void {
    if (this.current !== child || this.stopped) {
      return;
    }
    this.logger.error(`[${plan.label}] worker stopped answering; restarting it`);
    this.release(child, new Error("python worker stopped answering"));
    child.process.kill("SIGKILL");
    this.gate = createGate();
    this.scheduleRestart(plan);
  }

  private release(child: ChildHandle, error: Error): void {
    clearInterval(child.heartbeat);
    child.client.rejectAll(error);
    if (this.current === child) {
      this.current = undefined;
    }
  }

  private handleExit(child: ChildHandle, plan: LaunchPlan, exitCode: number): void {
    clearInterval(child.heartbeat);
    child.client.rejectAll(new Error(`python worker exited (code ${exitCode})`));
    if (this.current !== child) {
      return;
    }
    this.current = undefined;
    if (this.stopped) {
      return;
    }
    if (Date.now() - child.startedAt > STABLE_RUN_MS) {
      this.restartDelayMs = INITIAL_BACKOFF_MS;
    }
    this.logger.error(`[${plan.label}] worker exited with code ${exitCode}; restarting in ${this.restartDelayMs}ms`);
    this.gate = createGate();
    this.scheduleRestart(plan);
  }

  private scheduleRestart(plan: LaunchPlan): void {
    const delay = this.restartDelayMs;
    this.restartDelayMs = Math.min(this.restartDelayMs * 2, MAX_BACKOFF_MS);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.launch(plan);
    }, delay);
  }

  /** Closes stdin so the worker drains and exits; kills it if it does not within the grace period. */
  private async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    this.gate = createGate();
    this.gate.fail(new Error("python worker stopped"));
    const child = this.current;
    this.current = undefined;
    if (child === undefined) {
      return;
    }
    this.release(child, new Error("python worker stopped"));
    await shutDownChild(child);
  }
}

async function shutDownChild(child: ChildHandle): Promise<void> {
  try {
    await child.process.stdin.end();
  } catch {
    // stdin is already closed when the child died first.
  }
  const exitedInTime = await Promise.race([child.process.exited.then(() => true), Bun.sleep(STDIN_CLOSE_GRACE_MS).then(() => false)]);
  if (!exitedInTime) {
    child.process.kill("SIGKILL");
    await child.process.exited;
  }
}
