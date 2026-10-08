import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface EnvironmentLogger {
  info(message: string): void;
  error(message: string): void;
}

export const PYTHON_PACKAGE_DIRECTORY = path.resolve(import.meta.dir, "../../../python");
const CORE_REQUIREMENTS = path.join(PYTHON_PACKAGE_DIRECTORY, "requirements.txt");

const installQueues = new Map<string, Promise<unknown>>();

export function venvDirectory(cacheDirectory: string): string {
  return path.join(cacheDirectory, "python-venv");
}

function venvPython(venvPath: string): string {
  return path.join(venvPath, "bin", "python");
}

function requirementsDigest(files: string[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(fs.readFileSync(file));
  }
  return hash.digest("hex");
}

async function runCommand(command: string[], logger: EnvironmentLogger): Promise<void> {
  logger.info(command.join(" "));
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [exitCode, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed (${exitCode}): ${errors || output}`);
  }
}

async function createVenv(venvPath: string, logger: EnvironmentLogger): Promise<void> {
  if (fs.existsSync(venvPython(venvPath))) {
    return;
  }
  if (Bun.which("uv") !== null) {
    await runCommand(["uv", "venv", venvPath], logger);
    return;
  }
  await runCommand(["python3", "-m", "venv", venvPath], logger);
}

async function installRequirements(venvPath: string, files: string[], logger: EnvironmentLogger): Promise<void> {
  const interpreter = venvPython(venvPath);
  const flags = files.flatMap((file) => ["-r", file]);
  if (Bun.which("uv") !== null) {
    await runCommand(["uv", "pip", "install", "--python", interpreter, ...flags], logger);
    return;
  }
  await runCommand([interpreter, "-m", "pip", "install", ...flags], logger);
}

async function ensureVenvUnlocked(venvPath: string, requirements: string[], logger: EnvironmentLogger): Promise<string> {
  const files = [CORE_REQUIREMENTS, ...requirements];
  const stampDirectory = path.join(venvPath, ".atlas-stamps");
  const stampPath = path.join(stampDirectory, requirementsDigest(files));
  await createVenv(venvPath, logger);
  if (fs.existsSync(stampPath)) {
    return venvPython(venvPath);
  }
  await installRequirements(venvPath, files, logger);
  fs.mkdirSync(stampDirectory, { recursive: true });
  fs.writeFileSync(stampPath, files.join("\n"));
  return venvPython(venvPath);
}

function pendingInstall(venvPath: string): Promise<unknown> {
  const queued = installQueues.get(venvPath);
  if (queued === undefined) {
    return Promise.resolve();
  }
  return queued;
}

/**
 * Returns the interpreter of the shared venv, creating it and installing the requirement
 * files when a stamp for exactly this set is missing. `ATLAS_PYTHON` bypasses all of it.
 */
export function ensureInterpreter(cacheDirectory: string, requirements: string[], logger: EnvironmentLogger): Promise<string> {
  const override = process.env.ATLAS_PYTHON;
  if (override !== undefined && override !== "") {
    return Promise.resolve(override);
  }
  const venvPath = venvDirectory(cacheDirectory);
  // Concurrent spawns share one venv; serialize so installs never interleave.
  const previous = pendingInstall(venvPath);
  const next = previous.catch(() => undefined).then(() => ensureVenvUnlocked(venvPath, requirements, logger));
  installQueues.set(venvPath, next);
  return next;
}
