<script lang="ts">
	// Chat page for the assistant: starters, a transcript with visible tool calls, and a composer.
	import { kernelContext } from '@atlas/web/kernel';
	import { EmptyState, Select } from '@atlas/web/components';
	import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwiseIcon';
	import BrainIcon from 'phosphor-svelte/lib/BrainIcon';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
	import PaperPlaneRightIcon from 'phosphor-svelte/lib/PaperPlaneRightIcon';
	import SparkleIcon from 'phosphor-svelte/lib/SparkleIcon';
	import WrenchIcon from 'phosphor-svelte/lib/WrenchIcon';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import { conversation } from './conversation.svelte';
	import type { AssistantInfo } from './conversation.svelte';
	import Markdown from './Markdown.svelte';

	let { params }: { params: Record<string, string> } = $props();

	const ctx = kernelContext();

	let info = $state<AssistantInfo | undefined>(undefined);
	let loadError = $state('');
	let question = $state('');
	let expanded = $state<number | null>(null);
	let toolsShown = $state(false);
	let selectedBackend = $state('');

	const projectId = $derived(params.project);
	// Pages that link here can scope the conversation to one session with `?session=<id>`.
	const sessionId = $derived(sessionFromLocation());
	const starters = $derived(startersFor(sessionId));
	const backendOptions = $derived(optionsOf(info));
	const activeBackend = $derived(activeBackendOf(selectedBackend, info));

	function sessionFromLocation(): string | undefined {
		const session = new URLSearchParams(location.search).get('session');
		if (session === null || session === '') {
			return undefined;
		}
		return session;
	}

	function startersFor(session: string | undefined): string[] {
		if (session !== undefined) {
			return [
				'What is in this session?',
				'Which items should I label next here?',
				'Propose labels for 10 pending items',
				'Design a workflow for this session'
			];
		}
		return [
			'Which classes have the fewest labels?',
			'Propose labels for 10 pending items',
			'Which sessions need attention?',
			'Which of my classes are being confused?'
		];
	}

	function optionsOf(loaded: AssistantInfo | undefined) {
		if (loaded === undefined) {
			return [];
		}
		return loaded.backends.map((backend) => ({ value: backend.id, label: backend.label }));
	}

	function activeBackendOf(selected: string, loaded: AssistantInfo | undefined): string {
		if (selected !== '') {
			return selected;
		}
		if (loaded === undefined || loaded.defaultBackend === undefined) {
			return '';
		}
		return loaded.defaultBackend;
	}

	function messageOf(failure: unknown): string {
		if (failure instanceof Error) {
			return failure.message;
		}
		return String(failure);
	}

	$effect(() => {
		ctx.api.get<AssistantInfo>('/assistant').then(
			(loaded) => (info = loaded),
			(failure: unknown) => (loadError = messageOf(failure))
		);
	});

	async function ask(text: string) {
		await conversation.ask(ctx.api, text, { projectId, sessionId, backend: activeBackend });
	}

	async function send() {
		const text = question;
		question = '';
		await ask(text);
	}

	// Enter sends; Shift+Enter is a newline, since a question can be a paragraph.
	function onKeyDown(event: KeyboardEvent) {
		if (event.key !== 'Enter' || event.shiftKey) return;
		event.preventDefault();
		send();
	}

	function toggleExpanded(index: number) {
		expanded = expanded === index ? null : index;
	}
</script>

<div class="mx-auto flex h-full max-w-3xl flex-col p-6">
	{#if loadError}
		<div class="alert alert-error text-sm">{loadError}</div>
	{:else if info && !info.enabled}
		<EmptyState
			title="No assistant backend"
			hint="Enable an assistant backend plugin (for example assistant-ollama or assistant-claude) in atlas.json."
		/>
	{:else if info}
		<header class="mb-3 flex items-center gap-2">
			<SparkleIcon size={16} class="text-action" />
			<h1 class="text-default text-xl font-semibold tracking-tight">Assistant</h1>
			<div class="flex-1"></div>
			{#if backendOptions.length > 1}
				<Select value={activeBackend} options={backendOptions} onChange={(value) => (selectedBackend = value)} />
			{/if}
			<button type="button" class="btn btn-sm" title="Start over" onclick={() => conversation.reset()}>
				<ArrowClockwiseIcon size={13} />
			</button>
		</header>

		<div class="border-line bg-surface flex-1 space-y-2 overflow-y-auto rounded-lg border px-4 py-4">
			{#if conversation.entries.length === 0}
				<p class="text-dim text-sm leading-relaxed">
					I can read your sessions, items, classes and model metrics, and draft workflows. I write labels
					only as <span class="text-default">proposals</span> for you to confirm, and I never run a
					workflow, delete anything or change the label set.
				</p>

				<div class="flex flex-col gap-1 pt-1">
					{#each starters as starter (starter)}
						<button
							type="button"
							class="border-line text-muted hover:text-default hover:bg-hover/50 rounded-md border px-2.5 py-1.5 text-left text-xs"
							onclick={() => ask(starter)}
						>
							{starter}
						</button>
					{/each}
				</div>

				{#if info.tools.length}
					<div class="pt-1">
						<button
							type="button"
							class="text-faint hover:text-dim flex items-center gap-1 text-[11px]"
							onclick={() => (toolsShown = !toolsShown)}
						>
							<CaretDownIcon size={10} class={toolsShown ? '' : '-rotate-90'} />
							{info.tools.length} tools available
						</button>
						{#if toolsShown}
							<dl class="mt-1 space-y-1">
								{#each info.tools as tool (tool.name)}
									<div class="text-[11px] leading-snug">
										<dt class="text-muted font-mono">{tool.name}</dt>
										<dd class="text-faint">{tool.description}</dd>
									</div>
								{/each}
							</dl>
						{/if}
					</div>
				{/if}
			{/if}

			{#each conversation.entries as entry, index (index)}
				{#if entry.kind === 'user'}
					<div class="bg-hover text-default ml-6 rounded-lg px-3 py-2 text-sm whitespace-pre-wrap">
						{entry.text}
					</div>
				{:else if entry.kind === 'assistant'}
					<div class="text-default"><Markdown text={entry.text} /></div>
				{:else if entry.kind === 'error'}
					<div class="text-red border-line bg-red-soft rounded-lg border px-3 py-2 text-xs">
						{entry.text}
					</div>
				{:else if entry.kind === 'thinking'}
					<!-- Reasoning is kept out of the way: worth being able to check, not to read. -->
					<button
						type="button"
						class="text-faint hover:text-dim flex w-full items-start gap-1.5 text-left text-[11px]"
						onclick={() => toggleExpanded(index)}
					>
						<BrainIcon size={12} class="mt-0.5 shrink-0" />
						{#if expanded === index}
							<span class="min-w-0 flex-1 whitespace-pre-wrap">{entry.text}</span>
						{:else}
							<span class="truncate">thought for {entry.text.length} characters</span>
						{/if}
					</button>
				{:else}
					<button
						type="button"
						class="border-line text-dim hover:text-default flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left text-[11px]"
						onclick={() => toggleExpanded(index)}
					>
						<WrenchIcon size={12} class="mt-0.5 shrink-0" />
						<span class="min-w-0 flex-1">
							<span class="font-mono">{entry.tool}</span>
							{#if expanded === index}
								<span class="text-faint block break-words">{entry.detail}</span>
								{#if entry.result}
									<span class="text-faint mt-1 block break-words">{entry.result}</span>
								{/if}
							{/if}
						</span>
						{#if entry.result === undefined}
							<span class="loading loading-xs shrink-0"></span>
						{/if}
					</button>
				{/if}
			{/each}

			{#if conversation.busy}
				<div class="text-faint flex items-center gap-2 text-xs">
					<span class="loading loading-xs"></span> thinking…
				</div>
			{/if}
		</div>

		<div class="mt-3 flex items-end gap-2">
			<textarea
				class="input min-h-9 flex-1 resize-none py-2"
				rows="2"
				placeholder="Ask about your data…"
				bind:value={question}
				onkeydown={onKeyDown}
			></textarea>
			{#if conversation.busy}
				<button type="button" class="btn btn-sm" title="Stop" onclick={() => conversation.stop()}>
					<XIcon size={13} />
				</button>
			{:else}
				<button
					type="button"
					class="btn btn-sm btn-primary"
					title="Send"
					onclick={send}
					disabled={!question.trim()}
				>
					<PaperPlaneRightIcon size={13} />
				</button>
			{/if}
		</div>
	{:else}
		<div class="text-dim flex justify-center py-16"><span class="loading"></span></div>
	{/if}
</div>
