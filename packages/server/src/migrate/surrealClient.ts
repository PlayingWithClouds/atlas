export interface SurrealConnection {
  url: string;
  user: string;
  password: string;
  namespace: string;
  database: string;
}

/** Read-only access to the old database; tests substitute a fake. */
export interface SurrealReader {
  /** Runs one statement and returns its rows. */
  query<Row>(statement: string): Promise<Row[]>;
}

interface StatementResult {
  status: string;
  result: unknown;
}

export class SurrealUnreachableError extends Error {}

export function unreachableMessage(connection: SurrealConnection): string {
  return [
    `cannot reach SurrealDB at ${connection.url}.`,
    "Start the old database yourself, preferably on a COPY of its data directory, e.g.:",
    "  surreal start --bind 127.0.0.1:8020 --user root --pass root surrealkv://<path-to-copy>/atlas.db",
    "then pass its address as --from-surreal http://127.0.0.1:8020 (with --surreal-user/--surreal-pass if changed).",
  ].join("\n");
}

function sqlEndpoint(url: string): string {
  const base = url.replace(/^ws/, "http").replace(/\/rpc\/?$/, "").replace(/\/+$/, "");
  return `${base}/sql`;
}

function basicAuthorization(connection: SurrealConnection): string {
  const credentials = Buffer.from(`${connection.user}:${connection.password}`).toString("base64");
  return `Basic ${credentials}`;
}

function failureMessage(payload: unknown): string | undefined {
  if (!Array.isArray(payload)) {
    return `unexpected response: ${JSON.stringify(payload)}`;
  }
  for (const statement of payload as StatementResult[]) {
    if (statement.status !== "OK") {
      return String(statement.result);
    }
  }
  return undefined;
}

export class SurrealHttpClient implements SurrealReader {
  constructor(private readonly connection: SurrealConnection) {}

  async query<Row>(statement: string): Promise<Row[]> {
    const response = await this.post(statement);
    if (response.status === 401 || response.status === 403) {
      throw new Error("SurrealDB rejected the credentials; check --surreal-user and --surreal-pass");
    }
    const payload = await response.json();
    const failure = failureMessage(payload);
    if (failure !== undefined) {
      throw new Error(`SurrealDB query failed: ${failure}\n  ${statement}`);
    }
    return (payload as StatementResult[])[0].result as Row[];
  }

  private async post(statement: string): Promise<Response> {
    try {
      return await fetch(sqlEndpoint(this.connection.url), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "surreal-ns": this.connection.namespace,
          "surreal-db": this.connection.database,
          Authorization: basicAuthorization(this.connection),
        },
        body: statement,
      });
    } catch (error) {
      throw new SurrealUnreachableError(unreachableMessage(this.connection));
    }
  }
}
