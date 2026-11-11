<script lang="ts">
	// One group, as an accordion row: collapsed to a one-line summary of what is picked, expanded
	// (while it or one of its refinements has the focus) to a grid of its labels. Refinements, the
	// groups asked only while one of its labels is on, sit inside the card under that label.
	import type { Group, Suggestion } from '@atlas/contracts';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDown';
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRight';
	import ClockIcon from 'phosphor-svelte/lib/Clock';
	import type { Draft } from './draft';
	import { hasLabels, valuesOfGroup } from './draft';
	import LabelGrid from './LabelGrid.svelte';
	import { ACCEPT_THRESHOLD, probabilityOf, uncertaintyOf } from './suggestions';
	import UncertaintyMeter from './UncertaintyMeter.svelte';

	let {
		group,
		refinements,
		draft,
		focusedGroupId,
		suggestion,
		onfocus,
		ontoggle,
		onreviewed
	}: {
		group: Group;
		/** Active refinement groups of this group's labels. */
		refinements: Group[];
		draft: Draft;
		focusedGroupId: string | undefined;
		suggestion: Suggestion | undefined;
		onfocus: (groupId: string) => void;
		ontoggle: (group: Group, labelId: string) => void;
		onreviewed: (groupId: string, reviewed: boolean) => void;
	} = $props();

	let element = $state<HTMLElement>();

	const focused = $derived(focusedGroupId === group.id || refinements.some((refinement) => refinement.id === focusedGroupId));
	// Multi groups stay open: picking several labels should not need a click to open first.
	const expanded = $derived(focused || group.kind === 'multi');
	const holdsLabels = $derived(hasLabels(draft, group.id));
	const reviewed = $derived(holdsLabels || !draft.notReviewed.includes(group.id));
	const uncertainty = $derived(uncertaintyOf(suggestion, group));

	interface SummaryEntry {
		id: string;
		text: string;
		partial: boolean;
	}

	/** Picked labels (whole item or in ranges), each with the refinement labels picked under it. */
	const summary = $derived.by((): SummaryEntry[] => {
		const whole = valuesOfGroup(draft, group.id);
		return group.labels
			.filter((label) => whole.includes(label.id) || hasRangeFor(group.id, label.id))
			.map((label) => ({
				id: label.id,
				text: [label.name, ...refinementNamesOf(label.id)].join(' · '),
				partial: !whole.includes(label.id)
			}));
	});

	/** Strong suggestions shown in place of a summary while nothing is picked. */
	const proposals = $derived.by(() => {
		if (summary.length > 0) {
			return [];
		}
		return group.labels
			.map((label) => ({ label, probability: probabilityOf(suggestion, group.id, label.id) }))
			.filter((entry) => entry.probability !== undefined && entry.probability >= ACCEPT_THRESHOLD)
			.slice(0, 3);
	});

	function hasRangeFor(groupId: string, labelId: string): boolean {
		return draft.ranges.some((range) => range.group === groupId && range.label === labelId);
	}

	function refinementNamesOf(labelId: string): string[] {
		return refinements
			.filter((refinement) => refinement.when !== undefined && refinement.when.label === labelId)
			.flatMap((refinement) => refinement.labels.filter((label) => valuesOfGroup(draft, refinement.id).includes(label.id) || hasRangeFor(refinement.id, label.id)).map((label) => label.name));
	}

	function parentLabelName(refinement: Group): string {
		const condition = refinement.when;
		if (condition === undefined) {
			return '';
		}
		const parent = group.labels.find((label) => label.id === condition.label);
		if (parent === undefined) {
			return condition.label;
		}
		return parent.name;
	}

	function kindHint(of: Group): string {
		if (of.kind === 'single') {
			return 'pick one';
		}
		return 'pick any';
	}

	/** A few labels wrap at their own width; long lists get an even grid. */
	function columnsFor(of: Group): 2 | 'wrap' {
		if (of.labels.length <= 6) {
			return 'wrap';
		}
		return 2;
	}

	$effect(() => {
		if (focused) {
			element?.scrollIntoView({ block: 'nearest' });
		}
	});
</script>

<section bind:this={element} aria-label={group.label} class="border-line-faint border-b border-l-2 transition-colors {focused ? 'border-l-action bg-surface' : 'border-l-transparent hover:bg-hover/40'}">
	<button
		type="button"
		tabindex="-1"
		onmousedown={(event) => event.preventDefault()}
		onclick={() => onfocus(group.id)}
		class="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left"
		aria-expanded={expanded}
	>
		<span class="text-faint shrink-0">
			{#if expanded}<CaretDownIcon size={12} />{:else}<CaretRightIcon size={12} />{/if}
		</span>
		<span class="text-default shrink-0 text-sm font-semibold">{group.label}</span>
		{#if expanded}
			<span class="text-faint flex-1 text-[11px]">{kindHint(group)}</span>
		{:else}
			<span class="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
				{#each summary as entry (entry.id)}
					<span class="bg-raised text-default flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs">
						{#if entry.partial}<ClockIcon size={11} class="text-violet" />{/if}{entry.text}
					</span>
				{/each}
				{#each proposals as entry (entry.label.id)}
					<span class="border-green/60 text-muted shrink-0 rounded border border-dashed px-1.5 py-0.5 text-xs">{entry.label.name} {Math.round(Number(entry.probability) * 100)}%</span>
				{/each}
				{#if summary.length === 0 && proposals.length === 0}
					<span class="text-faint text-xs">{#if reviewed}none{:else}unknown{/if}</span>
				{/if}
			</span>
		{/if}
		{#if uncertainty !== undefined}<UncertaintyMeter {uncertainty} />{/if}
	</button>

	{#if expanded}
		<div class="flex flex-col gap-2 px-3 pb-3">
			<LabelGrid {group} {draft} {suggestion} columns={columnsFor(group)} ontoggle={(labelId) => ontoggle(group, labelId)} />

			{#each refinements as refinement (refinement.id)}
				{@const focusedHere = focusedGroupId === refinement.id}
				{@const refinementUncertainty = uncertaintyOf(suggestion, refinement)}
				<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
				<div class="border-violet/60 rounded-r-md border-l-2 py-1.5 pr-1 pl-3 {focusedHere ? 'bg-violet/10' : ''}" onclick={() => onfocus(refinement.id)}>
					<div class="mb-1.5 flex items-center gap-2 text-xs">
						<span class="text-violet">↳ {parentLabelName(refinement)}</span>
						<span class="font-semibold {focusedHere ? 'text-default' : 'text-muted'}">{refinement.label}</span>
						<span class="text-faint flex-1 text-[11px]">{kindHint(refinement)}</span>
					{#if refinementUncertainty !== undefined}<UncertaintyMeter uncertainty={refinementUncertainty} />{/if}
					</div>
					<LabelGrid group={refinement} {draft} {suggestion} columns={columnsFor(refinement)} ontoggle={(labelId) => ontoggle(refinement, labelId)} />
				</div>
			{/each}

			<label class="text-dim flex items-center gap-1.5 self-end text-[11px] {holdsLabels ? 'opacity-40' : ''}" title="Reviewed groups tell trainers 'none of these'; unreviewed ones stay unknown (U)">
				<input type="checkbox" class="toggle toggle-xs" checked={reviewed} disabled={holdsLabels} onchange={(event) => onreviewed(group.id, event.currentTarget.checked)} />
				reviewed
			</label>
		</div>
	{/if}
</section>
