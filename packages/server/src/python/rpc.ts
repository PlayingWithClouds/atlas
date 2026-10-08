export const DEFAULT_CALL_TIMEOUT_MS = 120_000;

interface PendingCall {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface RpcResponse {
  id?: number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export class RpcTimeoutError extends Error {}

export class RpcError extends Error {
  constructor(
    message: string,
    public readonly code: number,
  ) {
    super(message);
  }
}

/** JSON-RPC 2.0 client over line-delimited transport. One instance per child process. */
export class JsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();

  constructor(private readonly writeLine: (line: string) => void) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  call<T>(method: string, params: Record<string, unknown>, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.expire(id), timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.writeLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        this.settle(id)?.reject(error as Error);
      }
    });
  }

  /** Feeds one line read from the child's stdout. Non-protocol lines are ignored. */
  handleLine(line: string): void {
    const response = parseResponse(line);
    if (response === undefined || typeof response.id !== "number") {
      return;
    }
    const call = this.settle(response.id);
    if (call === undefined) {
      return;
    }
    if (response.error !== undefined) {
      call.reject(new RpcError(response.error.message, response.error.code));
      return;
    }
    call.resolve(response.result);
  }

  rejectAll(error: Error): void {
    for (const id of [...this.pending.keys()]) {
      this.settle(id)?.reject(error);
    }
  }

  private expire(id: number): void {
    const call = this.settle(id);
    if (call !== undefined) {
      call.reject(new RpcTimeoutError(`python call "${call.method}" timed out`));
    }
  }

  private settle(id: number): PendingCall | undefined {
    const call = this.pending.get(id);
    if (call === undefined) {
      return undefined;
    }
    this.pending.delete(id);
    clearTimeout(call.timer);
    return call;
  }
}

function parseResponse(line: string): RpcResponse | undefined {
  try {
    return JSON.parse(line) as RpcResponse;
  } catch {
    return undefined;
  }
}
