<script lang="ts">
	import { page } from '$app/stores';
	import {
		ask,
		available,
		entries,
		paneOpen,
		resetConversation,
		stopAsking,
		thinking
	} from '$lib/stores/assistant';
	import Markdown from './Markdown.svelte';
	import SparkleIcon from 'phosphor-svelte/lib/Sparkle';
	import PaperPlaneRightIcon from 'phosphor-svelte/lib/PaperPlaneRight';
	import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwise';
	import XIcon from 'phosphor-svelte/lib/X';
	import WrenchIcon from 'phosphor-svelte/lib/Wrench';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDown';
	import BrainIcon from 'phosphor-svelte/lib/Brain';

	let question = $state('');
	let expanded = $state<number | null>(null);
	let toolsShown = $state(false);

	const project = $derived($page.params.project);
	const sid = $derived($page.params.sid);

	// Openers, so the pane says what it is for instead of leaving a blank box. They
	// differ by where the user is: without a session open, half of them have no answer.
	const starters = $derived(
		sid
			? [
					'What is in this session?',
					'What should I label next here?',
					'Design a workflow for this session',
					'Are these clips cut at the right boundaries?'
				]
			: [
					'Which sessions need attention?',
					'Which classes need more labels?',
					'Which of my classes are being confused?'
				]
	);

	async function send() {
		const text = question;
		question = '';
		await ask(text, { project, sid });
	}

	async function sendStarter(text: string) {
		await ask(text, { project, sid });
	}

	// Enter sends; Shift+Enter is a newline, since a question can be a paragraph.
	function onKeyDown(event: KeyboardEvent) {
		if (event.key !== 'Enter' || event.shiftKey) return;
		event.preventDefault();
		send();
	}
</script>

{#if $paneOpen && $available.enabled}
	<aside
		class="border-line-faint bg-elevated flex h-full w-96 shrink-0 flex-col rounded-xl border shadow-md"
	>
		<header class="border-line flex items-center gap-2 border-b px-3 py-2.5">
			<SparkleIcon size={15} class="text-action" />
			<span class="text-default text-sm font-semibold">Assistant</span>
			<span class="text-faint truncate text-[10px]">{$available.model}</span>
			<div class="flex-1"></div>
			<button
				type="button"
				class="text-dim hover:text-default hover:bg-hover rounded p-1"
				title="Start over"
				onclick={resetConversation}
			>
				<ArrowClockwiseIcon size={13} />
			</button>
			<button
				type="button"
				class="text-dim hover:text-default hover:bg-hover rounded p-1"
				title="Close"
				onclick={() => paneOpen.set(false)}
			>
				<XIcon size={13} />
			</button>
		</header>

		<div class="flex-1 space-y-2 overflow-y-auto px-3 py-3">
			{#if $entries.length === 0}
				<p class="text-dim text-xs leading-relaxed">
					I can read your sessions, entities, classes and model metrics, look at clips, and draft
					workflows. I write labels only as <span class="text-default">proposals</span> for you to
					confirm, and I never run a workflow, delete anything or change the taxonomy.
				</p>

				<div class="flex flex-col gap-1 pt-1">
					{#each starters as starter (starter)}
						<button
							type="button"
							class="border-line text-muted hover:text-default hover:bg-hover/50 rounded-md border px-2.5 py-1.5 text-left text-xs"
							onclick={() => sendStarter(starter)}
						>
							{starter}
						</button>
					{/each}
				</div>

				{#if $available.tools.length}
					<div class="pt-1">
						<button
							type="button"
							class="text-faint hover:text-dim flex items-center gap-1 text-[11px]"
							onclick={() => (toolsShown = !toolsShown)}
						>
							<CaretDownIcon size={10} class={toolsShown ? '' : '-rotate-90'} />
							{$available.tools.length} tools available
						</button>
						{#if toolsShown}
							<dl class="mt-1 space-y-1">
								{#each $available.tools as tool (tool.name)}
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

			{#each $entries as entry, index (index)}
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
					<!-- Reasoning is kept out of the way: it is worth being able to check, not to read. -->
					<button
						type="button"
						class="text-faint hover:text-dim flex w-full items-start gap-1.5 text-left text-[11px]"
						onclick={() => (expanded = expanded === index ? null : index)}
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
						onclick={() => (expanded = expanded === index ? null : index)}
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

			{#if $thinking}
				<div class="text-faint flex items-center gap-2 text-xs">
					<span class="loading loading-xs"></span> thinking…
				</div>
			{/if}
		</div>

		<div class="border-line border-t p-2">
			<div class="flex items-end gap-2">
				<textarea
					class="input min-h-9 flex-1 resize-none py-2"
					rows="2"
					placeholder="Ask about this session…"
					bind:value={question}
					onkeydown={onKeyDown}
				></textarea>
				{#if $thinking}
					<button type="button" class="btn btn-sm" title="Stop" onclick={stopAsking}>
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
		</div>
	</aside>
{/if}
