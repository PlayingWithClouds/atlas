<script lang="ts">
	import type { Group } from '@atlas/contracts';
	import type { LabelingSession } from './labelingSession.svelte';
	import GroupCard from './GroupCard.svelte';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDown';
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRight';
	import SparkleIcon from 'phosphor-svelte/lib/Sparkle';

	let { session }: { session: LabelingSession } = $props();

	const moreCount = $derived(session.layout.more.length);
</script>

{#snippet card(group: Group)}
	<GroupCard
		{group}
		draft={session.draft}
		focused={session.focusedGroup?.id === group.id}
		suggestion={session.suggestion}
		onfocus={() => session.focusGroup(group.id)}
		ontoggle={(labelId) => session.toggle(group, labelId)}
		onreviewed={(reviewed) => session.setReviewed(group.id, reviewed)}
	/>
{/snippet}

<div class="flex flex-col gap-2">
	{#if session.suggestion}
		<div class="border-line bg-surface flex items-center gap-2 rounded-lg border px-3 py-2 text-xs">
			<SparkleIcon size={14} class="text-green" />
			<span class="text-muted flex-1">Suggestions from <span class="font-mono">{session.suggestion.source}</span> are proposals, not labels.</span>
			<button type="button" tabindex="-1" class="btn btn-sm btn-outline" disabled={!session.acceptable} onclick={() => session.acceptSuggestions()}>
				Accept (A)
			</button>
		</div>
	{/if}

	{#each session.layout.primary as group (group.id)}
		{@render card(group)}
	{/each}

	{#if moreCount > 0}
		<button
			type="button"
			tabindex="-1"
			onmousedown={(event) => event.preventDefault()}
			onclick={() => session.toggleMore()}
			class="text-dim hover:text-default flex items-center gap-1.5 px-1 py-1 text-left text-xs font-medium"
		>
			{#if session.draft.moreExpanded}<CaretDownIcon size={12} />{:else}<CaretRightIcon size={12} />{/if}
			More groups ({moreCount})
			<span class="text-faint font-normal">
				{#if session.draft.moreExpanded}reviewed while open{:else}unknown while closed{/if} (G)
			</span>
		</button>
		{#if session.draft.moreExpanded}
			{#each session.layout.more as group (group.id)}
				{@render card(group)}
			{/each}
		{/if}
	{/if}
</div>
