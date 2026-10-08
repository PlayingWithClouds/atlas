import path from "node:path";
import { createHost } from "./host";
import { ensureWorkspace } from "./services/workspace";

interface CliArguments {
  command: "serve" | "init";
  workspaceDirectory: string | undefined;
  port: number | undefined;
}

function parsePort(text: string | undefined): number | undefined {
  if (text === undefined || text === "") {
    return undefined;
  }
  const port = Number(text);
  if (!Number.isInteger(port) || port < 0) {
    throw new Error(`invalid port: ${text}`);
  }
  return port;
}

function parseArguments(argv: string[]): CliArguments {
  const positional: string[] = [];
  let portText = process.env.ATLAS_PORT;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--port") {
      index += 1;
      portText = argv[index];
      continue;
    }
    positional.push(argv[index]);
  }
  const command = positional[0] === "init" ? "init" : "serve";
  const directoryArgument = command === "init" ? positional[1] : positional[0];
  return {
    command,
    workspaceDirectory: directoryArgument || process.env.ATLAS_WORKSPACE,
    port: parsePort(portText),
  };
}

async function serve(workspaceDirectory: string, port: number | undefined): Promise<void> {
  const host = await createHost({ workspaceDirectory, port });
  console.log(`atlas serving ${workspaceDirectory} on http://localhost:${host.context.http.port}`);
  const shutdown = async () => {
    await host.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  if (process.argv[2] === "migrate") {
    const { migrateCommand } = await import("./migrate/cli");
    process.exit(await migrateCommand(process.argv.slice(3)));
  }
  const args = parseArguments(process.argv.slice(2));
  if (!args.workspaceDirectory) {
    console.error("usage: main.ts [init] <workspaceDir> [--port N]");
    process.exit(2);
  }
  const workspaceDirectory = path.resolve(args.workspaceDirectory);
  if (args.command === "init") {
    ensureWorkspace(workspaceDirectory);
    console.log(`initialized ${workspaceDirectory}`);
    return;
  }
  await serve(workspaceDirectory, args.port);
}

await main();
