<script lang="ts">
	import type { Group, Suggestion } from '@atlas/contracts';
	import type { Draft } from './draft';
	import { hasLabels, offeredLabels, valuesOfGroup } from './draft';
	import LabelChip from './LabelChip.svelte';
	import { probabilityOf } from './suggestions';

	let {
		group,
		draft,
		focused,
		suggestion,
		onfocus,
		ontoggle,
		onreviewed
	}: {
		group: Group;
		draft: Draft;
		focused: boolean;
		suggestion: Suggestion | undefined;
		onfocus: () => void;
		ontoggle: (labelId: string) => void;
		onreviewed: (reviewed: boolean) => void;
	} = $props();

	let element = $state<HTMLElement>();

	const labels = $derived(offeredLabels(group, draft));
	const selectedIds = $derived(valuesOfGroup(draft, group.id));
	const holdsLabels = $derived(hasLabels(draft, group.id));
	const kindHint = $derived.by(() => {
		if (group.kind === 'single') {
			return 'pick one';
		}
		return 'pick any';
	});
	const reviewed = $derived(holdsLabels || !draft.notReviewed.includes(group.id));

	function badgeOf(labelHotkey: string | undefined, index: number): string | undefined {
		if (labelHotkey !== undefined) {
			return labelHotkey.toUpperCase();
		}
		if (index < 9) {
			return String(index + 1);
		}
		return undefined;
	}

	function hasRange(labelId: string): boolean {
		return draft.ranges.some((range) => range.group === group.id && range.label === labelId);
	}

	$effect(() => {
		if (focused) {
			element?.scrollIntoView({ block: 'nearest' });
		}
	});
</script>

<!-- Clicking anywhere in the card focuses it; keyboard focus is handled by the screen's global keys. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events -->
<section
	bind:this={element}
	aria-label={group.label}
	onclick={onfocus}
	class="rounded-lg border p-3 transition-colors {focused ? 'border-line-strong bg-surface' : 'border-line-faint'}"
>
	<header class="mb-2 flex items-center gap-2">
		<h3 class="text-default text-sm font-semibold">{group.label}</h3>
		<span class="text-faint text-[11px]">{kindHint}</span>
		{#if group.when}
			<span class="text-faint text-[11px]">· when {group.when.group} is {group.when.label}</span>
		{/if}
		<label
			class="text-dim ml-auto flex items-center gap-1.5 text-[11px] {holdsLabels ? 'opacity-40' : ''}"
			title="Reviewed groups tell trainers 'none of these'; unreviewed ones stay unknown (U)"
		>
			<input
				type="checkbox"
				class="toggle toggle-sm"
				checked={reviewed}
				disabled={holdsLabels}
				onchange={(event) => onreviewed(event.currentTarget.checked)}
			/>
			reviewed
		</label>
	</header>
	<div class="flex flex-wrap gap-1.5">
		{#each labels as label, index (label.id)}
			<LabelChip
				{label}
				selected={selectedIds.includes(label.id)}
				hasRange={hasRange(label.id)}
				probability={probabilityOf(suggestion, group.id, label.id)}
				badge={badgeOf(label.hotkey, index)}
				onclick={() => ontoggle(label.id)}
			/>
		{/each}
	</div>
</section>
