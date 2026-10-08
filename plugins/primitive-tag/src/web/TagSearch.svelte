<script lang="ts">
	import { onMount } from 'svelte';
	import { searchClasses } from './itemTags';

	let {
		classNames,
		selected,
		suggestions = {},
		placeholder = 'Search tags… (1–9 pick)',
		onPick,
		onSubmit,
		onKey
	}: {
		classNames: string[];
		selected: Set<string>;
		suggestions?: Record<string, number>;
		placeholder?: string;
		onPick: (name: string) => void;
		/** Enter with no query; shift means "save and move on". */
		onSubmit?: (shiftKey: boolean) => void;
		/** Gets keys the search box does not use itself (empty query only). */
		onKey?: (event: KeyboardEvent) => void;
	} = $props();

	let query = $state('');
	let inputElement = $state<HTMLInputElement | null>(null);

	const results = $derived(searchClasses(classNames, query, suggestions));

	onMount(() => inputElement?.focus());

	function pick(name: string) {
		onPick(name);
		query = '';
		queueMicrotask(() => inputElement?.focus());
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key >= '1' && event.key <= '9' && query !== '') {
			const name = results[Number(event.key) - 1];
			if (name) {
				event.preventDefault();
				pick(name);
			}
			return;
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			if (results.length > 0 && !event.shiftKey) {
				pick(results[0]);
				return;
			}
			onSubmit?.(event.shiftKey);
			return;
		}
		if (event.key === 'Escape' && query !== '') {
			event.preventDefault();
			event.stopPropagation();
			query = '';
			return;
		}
		if (query === '') {
			onKey?.(event);
		}
	}
</script>

<div>
	<input
		bind:this={inputElement}
		bind:value={query}
		onkeydown={onKeydown}
		{placeholder}
		spellcheck="false"
		autocomplete="off"
		class="input input-sm w-full"
	/>
	{#if results.length}
		<div class="mt-2 flex flex-col gap-0.5">
			{#each results as name, index (name)}
				{@const on = selected.has(name)}
				{@const probability = suggestions[name]}
				<button
					type="button"
					onclick={() => pick(name)}
					class="flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm {on ? 'bg-primary text-primary-content' : 'hover:bg-hover text-default'}"
				>
					<span class="font-mono text-[11px] {on ? 'opacity-70' : 'text-faint'}">{index + 1}</span>
					<span class="flex-1">{name}</span>
					{#if probability !== undefined}
						<span class="font-mono text-[11px] {on ? 'opacity-70' : 'text-green'}">{Math.round(probability * 100)}%</span>
					{/if}
				</button>
			{/each}
		</div>
	{/if}
</div>
