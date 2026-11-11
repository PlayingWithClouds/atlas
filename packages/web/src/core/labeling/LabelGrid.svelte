<script lang="ts">
	// The labels of one group as an even grid of chips, with hotkeys (or the digit reaching them).
	import type { Group, Suggestion } from '@atlas/contracts';
	import type { Draft } from './draft';
	import { offeredLabels, valuesOfGroup } from './draft';
	import LabelChip from './LabelChip.svelte';
	import { probabilityOf } from './suggestions';

	let {
		group,
		draft,
		suggestion,
		columns,
		ontoggle
	}: {
		group: Group;
		draft: Draft;
		suggestion: Suggestion | undefined;
		/** A two-column grid for long lists; `wrap` lets a few labels sit side by side at their own width. */
		columns: 2 | 'wrap';
		ontoggle: (labelId: string) => void;
	} = $props();

	const labels = $derived(offeredLabels(group, draft));
	const selectedIds = $derived(valuesOfGroup(draft, group.id));
	const layoutClass = $derived.by(() => {
		if (columns === 'wrap') {
			return 'flex flex-wrap';
		}
		return 'grid grid-cols-2';
	});

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
</script>

<div class="gap-1 {layoutClass}">
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
