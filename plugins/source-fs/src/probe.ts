const PROBE_TIMEOUT_MS = 5000;

let ffprobeAvailable: boolean | undefined;

function hasFfprobe(): boolean {
  if (ffprobeAvailable === undefined) {
    ffprobeAvailable = Bun.which("ffprobe") !== null;
  }
  return ffprobeAvailable;
}

/** Duration in seconds, or undefined when ffprobe is missing or cannot read the file. */
export async function probeDuration(filePath: string): Promise<number | undefined> {
  if (!hasFfprobe()) {
    return undefined;
  }
  const process = Bun.spawn(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", filePath],
    { stdout: "pipe", stderr: "ignore", timeout: PROBE_TIMEOUT_MS },
  );
  const output = await new Response(process.stdout).text();
  const seconds = Number.parseFloat(output.trim());
  if (!Number.isFinite(seconds)) {
    return undefined;
  }
  return seconds;
}
