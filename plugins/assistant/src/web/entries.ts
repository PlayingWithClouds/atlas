import type { AssistantEvent, AssistantMessage } from '../types';

/** What the page shows. Tool entries are the assistant's working, kept visible so it is auditable. */
export type Entry =
	| { kind: 'user'; text: string }
	| { kind: 'assistant'; text: string }
	| { kind: 'tool'; tool: string; detail: string; result?: string }
	| { kind: 'thinking'; text: string }
	| { kind: 'error'; text: string };

function attachToolResult(entries: Entry[], result: string): Entry[] {
	const updated = [...entries];
	for (let index = updated.length - 1; index >= 0; index -= 1) {
		const entry = updated[index];
		if (entry.kind === 'tool' && entry.result === undefined) {
			updated[index] = { ...entry, result };
			break;
		}
	}
	return updated;
}

function textOf(value: string | undefined, fallback: string): string {
	if (value === undefined || value === '') {
		return fallback;
	}
	return value;
}

/** Folds one backend event into the entry list; session and done events are handled by the caller. */
export function reduceEntries(entries: Entry[], event: AssistantEvent): Entry[] {
	switch (event.kind) {
		case 'tool':
			return [...entries, { kind: 'tool', tool: textOf(event.tool, ''), detail: textOf(event.detail, '') }];
		case 'tool_result':
			return attachToolResult(entries, textOf(event.detail, ''));
		case 'thinking':
			return [...entries, { kind: 'thinking', text: textOf(event.content, '') }];
		case 'error':
			return [...entries, { kind: 'error', text: textOf(event.content, 'something went wrong') }];
		case 'message':
			return [...entries, { kind: 'assistant', text: textOf(event.content, '') }];
		default:
			return entries;
	}
}

/** The `done` event carries the turn's messages as JSON so the next turn keeps the tool results. */
export function parseMessages(raw: string | undefined): AssistantMessage[] {
	if (raw === undefined || raw === '') {
		return [];
	}
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			return parsed as AssistantMessage[];
		}
	} catch (error) {
		// A transcript that cannot be parsed just means the next turn starts colder.
	}
	return [];
}

/** Splits a text buffer into complete SSE frames' events, returning the unfinished tail. */
export function takeEvents(buffer: string): { events: AssistantEvent[]; rest: string } {
	const frames = buffer.split('\n\n');
	const rest = frames.pop();
	const events: AssistantEvent[] = [];
	for (const frame of frames) {
		const payload = frame.replace(/^data: /, '').trim();
		if (payload === '') {
			continue;
		}
		try {
			events.push(JSON.parse(payload) as AssistantEvent);
		} catch (error) {
			// A frame that cannot be read is not worth failing the stream over.
		}
	}
	return { events, rest: rest === undefined ? '' : rest };
}
