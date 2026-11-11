<script lang="ts">
	import type { Group } from '@atlas/contracts';
	import type { LabelingSession } from './labelingSession.svelte';
	import { activeRefinements } from './draft';
	import GroupCard from './GroupCard.svelte';
	import LabelSearch from './LabelSearch.svelte';
	import { formatClock } from '../shared/time';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDown';
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRight';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';
	import SparkleIcon from 'phosphor-svelte/lib/Sparkle';

	let { session }: { session: LabelingSession } = $props();

	const moreCount = $derived(session.layout.more.length);

	function labelName(groupId: string, labelId: string): string {
		const group = session.taxonomy?.groups.find((candidate) => candidate.id === groupId);
		const label = group?.labels.find((candidate) => candidate.id === labelId);
		if (label === undefined) {
			return labelId;
		}
		return label.name;
	}

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
	<div class="sticky top-0 z-10">
		<div class="border-line bg-canvas text-dim flex h-10 items-center gap-2 border-b px-3 text-sm">
			{#if session.suggestion}
				<SparkleIcon size={13} class="text-green" />
				<span class="flex-1">Proposals from <span class="font-mono">{session.suggestion.source}</span></span>
				<button type="button" tabindex="-1" class="btn btn-xs btn-ghost" disabled={!session.acceptable} onmousedown={(event) => event.preventDefault()} onclick={() => session.acceptSuggestions()}>
					Accept <span class="font-mono opacity-50">A</span>
				</button>
			{:else}
				<span class="flex-1">No proposals for this item yet</span>
			{/if}
			<button type="button" tabindex="-1" class="btn btn-xs btn-ghost" onmousedown={(event) => event.preventDefault()} onclick={() => (session.searchOpen = true)} title="Search labels (/)">
				<MagnifyingGlassIcon size={13} /> <span class="font-mono opacity-50">/</span>
			</button>
		</div>
		{#if session.searchOpen}
			<LabelSearch {session} />
		{/if}
		{#if session.openRanges.length > 0}
			<div class="border-line bg-violet/10 flex flex-wrap items-center gap-1.5 border-b px-3 py-2 text-sm">
				<span class="bg-violet size-2 shrink-0 animate-pulse rounded-full"></span>
				<span class="text-muted">Started at {formatClock(session.itemStart + session.openRanges[0].start, 2)}:</span>
				{#each session.openRanges as open (open.group + '.' + open.label)}
					<span class="bg-violet/25 text-default rounded px-1.5 py-0.5">{labelName(open.group, open.label)}</span>
				{/each}
				<span class="text-faint ml-auto"><kbd class="font-mono">]</kbd> end · <kbd class="font-mono">⇧F</kbd> whole · <kbd class="font-mono">Esc</kbd> drop</span>
			</div>
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
			class="text-dim hover:text-default border-line-faint flex items-center gap-1.5 border-b px-3 py-2 text-left text-sm font-medium"
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
