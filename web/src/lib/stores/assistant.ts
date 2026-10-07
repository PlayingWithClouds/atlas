import { writable, get as readStore } from 'svelte/store';
import { browser } from '$app/environment';
import {
	getAssistantConfig,
	streamChat,
	type AssistantConfig,
	type AssistantEvent,
	type AssistantMessage
} from '$lib/api/assistant';

// What the pane shows. Tool entries are the assistant's working, kept visible so what
// it did is auditable rather than narrated.
export type Entry =
	| { kind: 'user'; text: string }
	| { kind: 'assistant'; text: string }
	| { kind: 'tool'; tool: string; detail: string; result?: string }
	| { kind: 'thinking'; text: string }
	| { kind: 'error'; text: string };

export const paneOpen = writable(false);
export const available = writable<AssistantConfig>({
	enabled: false,
	backend: 'ollama',
	model: '',
	vision: false,
	tools: []
});
export const entries = writable<Entry[]>([]);
export const thinking = writable(false);

// The conversation as the model sees it, including tool results, so a follow-up does
// not make it re-read everything it already looked at.
let transcript: AssistantMessage[] = [];
// A backend that keeps its own transcript (Claude Code) names the conversation instead.
// The pane holds the id so atlas stores no conversation state of its own.
let session = '';
let inFlight: AbortController | null = null;

export function toggleAssistant(): void {
	paneOpen.update((open) => !open);
}

export async function loadAssistantConfig(): Promise<void> {
	if (!browser) return;
	try {
		const config = await getAssistantConfig();
		// A backend older than the tool list simply reports no tools, rather than
		// leaving the pane to read a field that is not there.
		available.set({ ...config, tools: config.tools ?? [] });
	} catch {
		available.set({ enabled: false, backend: 'ollama', model: '', vision: false, tools: [] });
	}
}

export function resetConversation(): void {
	transcript = [];
	session = '';
	entries.set([]);
}

export async function ask(question: string, context: { project?: string; sid?: string }): Promise<void> {
	const text = question.trim();
	if (!text || readStore(thinking)) return;

	transcript = [...transcript, { role: 'user', content: text }];
	entries.update((list) => [...list, { kind: 'user', text }]);
	thinking.set(true);
	inFlight = new AbortController();

	try {
		await streamChat({ messages: transcript, session, ...context }, applyEvent, inFlight.signal);
	} catch (error) {
		entries.update((list) => [...list, { kind: 'error', text: (error as Error).message }]);
	} finally {
		thinking.set(false);
		inFlight = null;
	}
}

export function stopAsking(): void {
	inFlight?.abort();
}

function applyEvent(event: AssistantEvent): void {
	if (event.kind === 'session') {
		session = event.session ?? '';
		return;
	}
	if (event.kind === 'done') {
		// The backend hands back the turn's messages so the next question carries the
		// tool results with it.
		transcript = [...transcript, ...parseMessages(event.content)];
		return;
	}
	entries.update((list) => reduce(list, event));
}

function reduce(list: Entry[], event: AssistantEvent): Entry[] {
	if (event.kind === 'tool') {
		return [...list, { kind: 'tool', tool: event.tool ?? '', detail: event.detail ?? '' }];
	}
	if (event.kind === 'tool_result') {
		// Attach the result to the call it answers, which is the last tool entry.
		const updated = [...list];
		for (let index = updated.length - 1; index >= 0; index--) {
			const entry = updated[index];
			if (entry.kind === 'tool' && entry.result === undefined) {
				updated[index] = { ...entry, result: event.detail ?? '' };
				break;
			}
		}
		return updated;
	}
	if (event.kind === 'thinking') {
		return [...list, { kind: 'thinking', text: event.content ?? '' }];
	}
	if (event.kind === 'error') {
		return [...list, { kind: 'error', text: event.content ?? 'something went wrong' }];
	}
	return [...list, { kind: 'assistant', text: event.content ?? '' }];
}

function parseMessages(raw: string | undefined): AssistantMessage[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) return parsed as AssistantMessage[];
	} catch {
		// a transcript we cannot parse just means the next turn starts colder
	}
	return [];
}
