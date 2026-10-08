import type { ApiClient } from '@atlas/contracts/web';
import type { AssistantEvent, AssistantMessage } from '../types';
import { parseMessages, reduceEntries, takeEvents } from './entries';
import type { Entry } from './entries';

export interface AssistantTool {
	name: string;
	description: string;
}

export interface AssistantInfo {
	enabled: boolean;
	backends: { id: string; label: string }[];
	defaultBackend?: string;
	tools: AssistantTool[];
}

export interface AskContext {
	projectId?: string;
	sessionId?: string;
	backend?: string;
}

async function readStream(response: Response, onEvent: (event: AssistantEvent) => void): Promise<void> {
	if (!response.ok || !response.body) {
		throw new Error(`assistant unavailable (${response.status})`);
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			return;
		}
		buffer += decoder.decode(value, { stream: true });
		const taken = takeEvents(buffer);
		buffer = taken.rest;
		for (const event of taken.events) {
			onEvent(event);
		}
	}
}

function sessionIdOf(event: AssistantEvent): string {
	if (event.session === undefined) {
		return '';
	}
	return event.session;
}

function messageOf(failure: unknown): string {
	if (failure instanceof Error) {
		return failure.message;
	}
	return String(failure);
}

/** One conversation, kept at module level so it survives navigating away from the page. */
export class Conversation {
	entries = $state<Entry[]>([]);
	busy = $state(false);

	// The conversation as the model sees it, so a follow-up does not re-read everything.
	private transcript: AssistantMessage[] = [];
	// Backends that keep their own transcript name it; the page only holds the id.
	private session = '';
	private controller: AbortController | undefined;

	reset(): void {
		this.stop();
		this.transcript = [];
		this.session = '';
		this.entries = [];
	}

	stop(): void {
		this.controller?.abort();
	}

	async ask(api: ApiClient, question: string, context: AskContext): Promise<void> {
		const text = question.trim();
		if (text === '' || this.busy) {
			return;
		}
		this.transcript = [...this.transcript, { role: 'user', content: text }];
		this.entries = [...this.entries, { kind: 'user', text }];
		this.busy = true;
		this.controller = new AbortController();
		try {
			await this.stream(api, context, this.controller.signal);
		} catch (failure) {
			this.handleFailure(failure);
		} finally {
			this.busy = false;
			this.controller = undefined;
		}
	}

	private async stream(api: ApiClient, context: AskContext, signal: AbortSignal): Promise<void> {
		const response = await fetch(api.url('/assistant/chat'), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ messages: this.transcript, session: this.session, ...context }),
			signal
		});
		await readStream(response, (event) => this.apply(event));
	}

	private handleFailure(failure: unknown): void {
		if (failure instanceof DOMException && failure.name === 'AbortError') {
			return;
		}
		this.entries = [...this.entries, { kind: 'error', text: messageOf(failure) }];
	}

	private apply(event: AssistantEvent): void {
		if (event.kind === 'session') {
			this.session = sessionIdOf(event);
			return;
		}
		if (event.kind === 'done') {
			this.transcript = [...this.transcript, ...parseMessages(event.content)];
			return;
		}
		this.entries = reduceEntries(this.entries, event);
	}
}

export const conversation = new Conversation();
