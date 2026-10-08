import type { AssistantEmit } from "@atlas/plugin-assistant/types";

const SUMMARY_LIMIT = 240;

function orEmpty(value: string | undefined): string {
  if (value === undefined) {
    return "";
  }
  return value;
}

interface ClaudeBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  id?: string;
  tool_use_id?: string;
  content?: unknown;
}

interface ClaudeEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: ClaudeBlock[] };
  result?: string;
  is_error?: boolean;
}

/** What one CLI run produced: its final answer, and how much it reported before ending. */
export interface Outcome {
  text: string;
  events: number;
}

export function summarize(text: string): string {
  if (text.length <= SUMMARY_LIMIT) {
    return text;
  }
  return `${text.slice(0, SUMMARY_LIMIT)}…`;
}

/** Flattens a tool result, whose content is a bare string on some tools and typed blocks on others. */
export function resultText(content: unknown): string {
  if (content === undefined || content === null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return JSON.stringify(content);
  }
  const parts: string[] = [];
  for (const block of content as ClaudeBlock[]) {
    if (typeof block.text === "string" && block.text !== "") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function resultError(event: ClaudeEvent): string {
  if (event.result !== undefined && event.result !== "") {
    return event.result;
  }
  if (event.subtype !== undefined && event.subtype !== "") {
    return `the assistant stopped: ${event.subtype}`;
  }
  return "the assistant stopped without an answer";
}

function blocksOf(event: ClaudeEvent): ClaudeBlock[] {
  if (event.message === undefined || !Array.isArray(event.message.content)) {
    return [];
  }
  return event.message.content;
}

/**
 * Translates the CLI's stream-json lines into assistant events. Only the fields the page needs are
 * read, so a new field in a later CLI version cannot break the parse.
 */
export class ClaudeStreamTranslator {
  private readonly toolNames = new Map<string, string>();
  private announcedSession = "";
  readonly outcome: Outcome = { text: "", events: 0 };

  constructor(private readonly emit: AssistantEmit) {}

  /** Lines that are not valid JSON (a truncated tail from a killed CLI) are skipped. */
  pushLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") {
      return;
    }
    let event: ClaudeEvent;
    try {
      event = JSON.parse(trimmed) as ClaudeEvent;
    } catch (error) {
      return;
    }
    this.outcome.events += 1;
    this.translate(event);
  }

  private translate(event: ClaudeEvent): void {
    switch (event.type) {
      case "system":
        this.announceSession(event);
        return;
      case "assistant":
        this.emitAssistantBlocks(blocksOf(event));
        return;
      case "user":
        this.emitToolResults(blocksOf(event));
        return;
      case "result":
        this.finish(event);
        return;
    }
  }

  // Every system event repeats the session id. It is sent as soon as it is known, so a turn that
  // later fails still leaves a resumable id.
  private announceSession(event: ClaudeEvent): void {
    if (event.session_id === undefined || event.session_id === "" || event.session_id === this.announcedSession) {
      return;
    }
    this.announcedSession = event.session_id;
    this.emit({ kind: "session", session: event.session_id });
  }

  private emitAssistantBlocks(blocks: ClaudeBlock[]): void {
    for (const block of blocks) {
      if (block.type === "text" && block.text !== undefined && block.text.trim() !== "") {
        this.emit({ kind: "message", content: block.text });
      }
      if (block.type === "thinking" && block.thinking !== undefined && block.thinking.trim() !== "") {
        this.emit({ kind: "thinking", content: block.thinking });
      }
      if (block.type === "tool_use") {
        this.emitToolUse(block);
      }
    }
  }

  private emitToolUse(block: ClaudeBlock): void {
    const name = orEmpty(block.name);
    if (block.id !== undefined) {
      this.toolNames.set(block.id, name);
    }
    this.emit({ kind: "tool", tool: name, detail: summarize(JSON.stringify(block.input)) });
  }

  // A tool result names only the call it answers, so the name seen on the way past labels it.
  private emitToolResults(blocks: ClaudeBlock[]): void {
    for (const block of blocks) {
      if (block.type !== "tool_result") {
        continue;
      }
      const tool = this.toolNames.get(orEmpty(block.tool_use_id));
      this.emit({ kind: "tool_result", tool, detail: summarize(resultText(block.content)) });
    }
  }

  private finish(event: ClaudeEvent): void {
    this.outcome.text = orEmpty(event.result);
    if (event.is_error === true) {
      this.emit({ kind: "error", content: resultError(event) });
      this.outcome.text = "";
    }
  }
}

/** Reads a process's stdout to the end, feeding complete lines to the translator. */
export async function readClaudeStream(stream: ReadableStream<Uint8Array>, emit: AssistantEmit): Promise<Outcome> {
  const translator = new ClaudeStreamTranslator(emit);
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() as string;
    for (const line of lines) {
      translator.pushLine(line);
    }
  }
  translator.pushLine(buffered + decoder.decode());
  return translator.outcome;
}

/** Keeps the end of a failed run's stderr, which is where the reason is. */
export function tail(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") {
    return "";
  }
  const limit = 500;
  if (trimmed.length > limit) {
    return `: …${trimmed.slice(trimmed.length - limit)}`;
  }
  return `: ${trimmed}`;
}
