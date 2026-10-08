<script lang="ts">
	import type { Item, LabelGroup } from '@atlas/contracts';
	import { untrack } from 'svelte';
		import { TagGrid } from '@atlas/web/components';
	import TagSearch from './TagSearch.svelte';
	import { classNamesOfGroups, tagsOnEvery, tagsOnSome } from './itemTags';
	import type { BatchEdit } from './itemTags';

	let {
		groups,
		items,
		busy,
		onApply,
		onCancel
	}: {
		groups: LabelGroup[];
		items: Item[];
		busy: boolean;
		onApply: (edit: BatchEdit) => void;
		onCancel: () => void;
	} = $props();

	const classNames = $derived(classNamesOfGroups(groups));

	// The dialog opens from what the selection already carries; tags on only some items are
	// offered separately instead of being silently applied to all.
	const initialCommon = untrack(() => tagsOnEvery(items));
	const seeded = new Set(initialCommon);
	let chosen = $state<Set<string>>(new Set(initialCommon));
	let partial = $state<Set<string>>(untrack(() => tagsOnSome(items, initialCommon)));
	let replace = $state(false);

	const canApply = $derived((chosen.size > 0 || seeded.size > 0) && !busy);

	function toggle(name: string) {
		const next = new Set(chosen);
		if (next.has(name)) {
			next.delete(name);
		} else {
			next.add(name);
		}
		chosen = next;
		if (partial.has(name)) {
			const rest = new Set(partial);
			rest.delete(name);
			partial = rest;
		}
	}

	function apply() {
		if (!canApply) return;
		onApply({ chosen, seeded, replace });
	}

	function onWindowKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			onCancel();
		}
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="fixed inset-0 z-[100] flex" style="background: var(--overlay-scrim)">
	<button type="button" class="absolute inset-0 cursor-default" aria-label="Close" onclick={onCancel}></button>

	<div class="border-line bg-surface relative z-10 m-auto flex max-h-[88vh] w-[94vw] max-w-4xl flex-col overflow-hidden rounded-xl border shadow-lg">
		<div class="border-line flex items-center justify-between gap-3 border-b px-4 py-3">
			<h3 class="text-default text-sm font-semibold">Assign tags to {items.length} items</h3>
			<div class="flex flex-wrap gap-1.5">
				{#each [...chosen] as tag (tag)}
					<button type="button" onclick={() => toggle(tag)} class="bg-primary text-primary-content flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold" title="Remove">
						{tag} <span class="opacity-60">×</span>
					</button>
				{/each}
				{#each [...partial] as tag (tag)}
					<button
						type="button"
						onclick={() => toggle(tag)}
						class="border-line text-dim flex items-center gap-1 rounded-full border border-dashed px-2.5 py-1 text-xs font-semibold"
						title="On some of the selected items — click to apply to all"
					>
						{tag} <span class="opacity-60">+</span>
					</button>
				{/each}
			</div>
		</div>

		<div class="border-line border-b p-3">
			<TagSearch {classNames} selected={chosen} onPick={toggle} />
		</div>

		<div class="min-h-0 flex-1 overflow-y-auto p-4">
			<TagGrid {groups} selected={chosen} onToggle={toggle} />
		</div>

		<div class="border-line flex items-center gap-3 border-t p-3">
			<label class="text-dim flex items-center gap-2 text-xs">
				<input type="checkbox" bind:checked={replace} /> Replace existing (else add)
			</label>
			<button type="button" class="btn btn-sm btn-ghost ml-auto" onclick={onCancel}>Cancel</button>
			<button type="button" class="btn btn-sm btn-primary" disabled={!canApply} onclick={apply}>
				{replace ? 'Replace on' : 'Save to'} {items.length}
			</button>
		</div>
	</div>
</div>
