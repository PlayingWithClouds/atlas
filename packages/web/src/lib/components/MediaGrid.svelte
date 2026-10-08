<script lang="ts">
	import type { Item, Session } from '@atlas/contracts';
	import type { Snippet } from 'svelte';
	import { kernelContext } from '../../kernel/context';
	import EmptyState from './EmptyState.svelte';

	let {
		items,
		session,
		selectedIds = new Set<string>(),
		activeId,
		minimumCellWidth = 180,
		onSelect,
		onOpen,
		overlay
	}: {
		items: Item[];
		session: Session;
		selectedIds?: Set<string>;
		activeId?: string;
		minimumCellWidth?: number;
		onSelect?: (item: Item, event: MouseEvent) => void;
		onOpen?: (item: Item) => void;
		/** Extra content layered over each cell, e.g. tags. */
		overlay?: Snippet<[Item]>;
	} = $props();

	const ctx = kernelContext();

	const missingKinds = $derived.by(() => {
		const kinds = new Set<string>();
		for (const item of items) {
			if (!ctx.mediaCells.list().some((cell) => cell.mediaKind === item.mediaKind)) {
				kinds.add(item.mediaKind);
			}
		}
		return [...kinds];
	});

	function cellFor(item: Item) {
		return ctx.mediaCells.list().find((cell) => cell.mediaKind === item.mediaKind);
	}

	function ringClass(item: Item): string {
		if (selectedIds.has(item.id)) {
			return 'border-primary ring-2 ring-primary';
		}
		if (item.status === 'labeled') {
			return 'border-green/60';
		}
		if (item.status === 'skipped') {
			return 'border-line opacity-50';
		}
		return 'border-line hover:border-line-strong';
	}
</script>

{#each missingKinds as kind (kind)}
	<div class="mb-3">
		<EmptyState
			title={`No cell for media kind "${kind}"`}
			hint="Enable a plugin that provides a media cell for this kind."
		/>
	</div>
{/each}

<div class="grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax({minimumCellWidth}px, 1fr))">
	{#each items as item (item.id)}
		{@const cell = cellFor(item)}
		<div
			class="bg-surface relative overflow-hidden rounded-lg border transition {ringClass(item)}"
			role="button"
			tabindex="0"
			onclick={(event) => onSelect?.(item, event)}
			ondblclick={() => onOpen?.(item)}
			onkeydown={(event) => event.key === 'Enter' && onOpen?.(item)}
		>
			{#if cell}
				<cell.component {item} {session} active={activeId === item.id} />
			{:else}
				<img
					src={ctx.api.url(`/items/${item.id}/thumbnail`)}
					alt=""
					class="aspect-[4/3] w-full object-cover"
					loading="lazy"
				/>
			{/if}
			{@render overlay?.(item)}
		</div>
	{/each}
</div>
