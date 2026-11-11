<script lang="ts">
	import type { Group } from '@atlas/contracts';
	import type { LabelingSession } from './labelingSession.svelte';
	import { activeRefinements } from './draft';
	import GroupCard from './GroupCard.svelte';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDown';
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRight';
	import SparkleIcon from 'phosphor-svelte/lib/Sparkle';

	let { session }: { session: LabelingSession } = $props();

	const moreCount = $derived(session.layout.more.length);

	function refinementsOf(group: Group): Group[] {
		if (session.taxonomy === undefined) {
			return [];
		}
		return activeRefinements(session.taxonomy, session.draft, group.id);
	}
</script>

{#snippet card(group: Group)}
	<GroupCard
		{group}
		refinements={refinementsOf(group)}
		draft={session.draft}
		focusedGroupId={session.focusedGroup?.id}
		suggestion={session.suggestion}
		onfocus={(groupId) => session.focusGroup(groupId)}
		ontoggle={(target, labelId) => session.toggle(target, labelId)}
		onreviewed={(groupId, reviewed) => session.setReviewed(groupId, reviewed)}
	/>
{/snippet}

<div class="flex flex-col">
	<div class="border-line bg-canvas text-dim sticky top-0 z-10 flex h-10 items-center gap-2 border-b px-3 text-xs">
		{#if session.suggestion}
			<SparkleIcon size={13} class="text-green" />
			<span class="flex-1">Proposals from <span class="font-mono">{session.suggestion.source}</span></span>
			<button type="button" tabindex="-1" class="btn btn-xs btn-ghost" disabled={!session.acceptable} onmousedown={(event) => event.preventDefault()} onclick={() => session.acceptSuggestions()}>
				Accept <span class="font-mono opacity-50">A</span>
			</button>
		{:else}
			<span class="flex-1">No proposals for this item yet</span>
		{/if}
	</div>

	{#each session.layout.primary as group (group.id)}
		{@render card(group)}
	{/each}

	{#if moreCount > 0}
		<button
			type="button"
			tabindex="-1"
			onmousedown={(event) => event.preventDefault()}
			onclick={() => session.toggleMore()}
			class="text-dim hover:text-default border-line-faint flex items-center gap-1.5 border-b px-3 py-2 text-left text-xs font-medium"
			title="Groups behind More count as reviewed while open, unknown while closed (G)"
		>
			{#if session.draft.moreExpanded}<CaretDownIcon size={12} />{:else}<CaretRightIcon size={12} />{/if}
			More groups ({moreCount})
			<span class="text-faint font-normal">{#if session.draft.moreExpanded}reviewed{:else}unknown{/if}</span>
		</button>
		{#if session.draft.moreExpanded}
			{#each session.layout.more as group (group.id)}
				{@render card(group)}
			{/each}
		{/if}
	{/if}
</div>
