import { get, apiUrl } from './client';

// One turn in the transcript. Tool messages carry a tool's result back to the model;
// the pane renders them as a collapsed row rather than as speech.
export type AssistantMessage = {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	tool_name?: string;
	tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
};

// What the backend reports while a turn runs. `session` names the backend's own
// conversation, which the pane holds and sends back so the next turn resumes it.
export type AssistantEvent = {
	kind: 'tool' | 'tool_result' | 'thinking' | 'message' | 'error' | 'session' | 'done';
	tool?: string;
	detail?: string;
	content?: string;
	session?: string;
};

// The tools the assistant can actually call, straight from the backend registry, so
// what the pane advertises cannot drift from what it can run.
export type AssistantTool = { name: string; description: string };

export type AssistantConfig = {
	enabled: boolean;
	// Which backend answers: 'ollama' runs a bounded tool loop against a local model,
	// 'claude' hands the turn to the Claude Code CLI, which also writes and runs code.
	backend: string;
	model: string;
	vision: boolean;
	tools: AssistantTool[];
};

export function getAssistantConfig(): Promise<AssistantConfig> {
	return get('/api/assistant');
}

// Streams a turn. The request is a POST, so this reads the SSE body itself rather than
// using EventSource, which can only GET. onEvent fires for every event as it lands.
export async function streamChat(
	body: { messages: AssistantMessage[]; project?: string; sid?: string; session?: string },
	onEvent: (event: AssistantEvent) => void,
	signal?: AbortSignal
): Promise<void> {
	const response = await fetch(apiUrl('/api/assistant/chat'), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal
	});
	if (!response.ok || !response.body) {
		throw new Error(`assistant unavailable (${response.status})`);
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		// SSE frames are separated by a blank line; a partial frame stays in the buffer.
		const frames = buffer.split('\n\n');
		buffer = frames.pop() ?? '';
		for (const frame of frames) {
			const payload = frame.replace(/^data: /, '').trim();
			if (!payload) continue;
			try {
				onEvent(JSON.parse(payload) as AssistantEvent);
			} catch {
				// a frame we cannot read is not worth failing the stream over
			}
		}
	}
}
