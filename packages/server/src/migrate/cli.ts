import path from "node:path";
import os from "node:os";
import { parseModelMap } from "./mapping";
import { runMigration } from "./migrate";
import type { MigrateOptions } from "./migrate";
import { SurrealHttpClient, SurrealUnreachableError } from "./surrealClient";

const USAGE = [
  "usage: main.ts migrate --from-surreal <ws or http url> [options] <targetWorkspace>",
  "  --surreal-user root --surreal-pass root   credentials (default root/root)",
  "  --surreal-ns atlas --surreal-db atlas     namespace and database (default atlas/atlas)",
  "  --old-config atlas.config.json            old deployment config (default ./atlas.config.json)",
  "  --old-cache ~/.cache/atlas                old pool root (default ~/.cache/atlas)",
  "  --model-map old=new                       repeatable; defaults model=joytag, siglip=siglip",
  "  --python <path>                           interpreter with numpy for pool copies",
  "  --veil-path <dir>                         veil atlas-source plugin directory",
  "  --skip-pools                              do not copy vector pools",
  "  --dry-run                                 print counts and planned copies, write nothing",
  "  --force                                   recreate the target database if it holds data",
].join("\n");

const VALUE_FLAGS = [
  "--from-surreal", "--surreal-user", "--surreal-pass", "--surreal-ns", "--surreal-db",
  "--old-config", "--old-cache", "--model-map", "--python", "--veil-path",
];
const BOOLEAN_FLAGS = ["--dry-run", "--force", "--skip-pools"];

interface ParsedFlags {
  values: Map<string, string[]>;
  booleans: Set<string>;
  positional: string[];
}

function parseFlags(argv: string[]): ParsedFlags {
  const parsed: ParsedFlags = { values: new Map(), booleans: new Set(), positional: [] };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (BOOLEAN_FLAGS.includes(argument)) {
      parsed.booleans.add(argument);
    } else if (VALUE_FLAGS.includes(argument)) {
      index += 1;
      parsed.values.set(argument, [...allValues(parsed, argument), argv[index]]);
    } else if (argument.startsWith("--")) {
      throw new Error(`unknown option ${argument}`);
    } else {
      parsed.positional.push(argument);
    }
  }
  return parsed;
}

function allValues(parsed: ParsedFlags, flag: string): string[] {
  const values = parsed.values.get(flag);
  if (values === undefined) {
    return [];
  }
  return values;
}

function lastValue(parsed: ParsedFlags, flag: string, fallback: string): string {
  const values = parsed.values.get(flag);
  if (values === undefined) {
    return fallback;
  }
  return values[values.length - 1];
}

function optionalValue(parsed: ParsedFlags, flag: string): string | undefined {
  const values = parsed.values.get(flag);
  if (values === undefined) {
    return undefined;
  }
  return values[values.length - 1];
}

function expandHome(filePath: string): string {
  if (filePath === "~" || filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

function buildOptions(parsed: ParsedFlags): MigrateOptions {
  return {
    targetDirectory: path.resolve(parsed.positional[0]),
    oldConfigPath: path.resolve(expandHome(lastValue(parsed, "--old-config", "atlas.config.json"))),
    oldCacheDirectory: path.resolve(expandHome(lastValue(parsed, "--old-cache", "~/.cache/atlas"))),
    modelMap: parseModelMap(allValues(parsed, "--model-map")),
    dryRun: parsed.booleans.has("--dry-run"),
    force: parsed.booleans.has("--force"),
    skipPools: parsed.booleans.has("--skip-pools"),
    pythonPath: optionalValue(parsed, "--python"),
    veilPluginDirectory: optionalValue(parsed, "--veil-path"),
    log: (line) => console.log(line),
  };
}

/** Returns the process exit code. */
export async function migrateCommand(argv: string[]): Promise<number> {
  try {
    const parsed = parseFlags(argv);
    const surrealUrl = optionalValue(parsed, "--from-surreal");
    if (surrealUrl === undefined || parsed.positional.length !== 1) {
      console.error(USAGE);
      return 2;
    }
    const reader = new SurrealHttpClient({
      url: surrealUrl,
      user: lastValue(parsed, "--surreal-user", "root"),
      password: lastValue(parsed, "--surreal-pass", "root"),
      namespace: lastValue(parsed, "--surreal-ns", "atlas"),
      database: lastValue(parsed, "--surreal-db", "atlas"),
    });
    await runMigration(reader, buildOptions(parsed));
    return 0;
  } catch (error) {
    if (error instanceof SurrealUnreachableError) {
      console.error(error.message);
      return 1;
    }
    console.error(`migration failed: ${(error as Error).message}`);
    return 1;
  }
}
