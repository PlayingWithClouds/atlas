/** Calls `onLine` for each newline-terminated line of a byte stream; resolves at end of stream. */
export async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffered = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    buffered += decoder.decode(chunk.value, { stream: true });
    buffered = emitCompleteLines(buffered, onLine);
  }
  if (buffered.length > 0) {
    onLine(buffered);
  }
}

function emitCompleteLines(buffered: string, onLine: (line: string) => void): string {
  let remaining = buffered;
  let newlineIndex = remaining.indexOf("\n");
  while (newlineIndex !== -1) {
    onLine(remaining.slice(0, newlineIndex));
    remaining = remaining.slice(newlineIndex + 1);
    newlineIndex = remaining.indexOf("\n");
  }
  return remaining;
}
