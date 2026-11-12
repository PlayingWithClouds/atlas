<script lang="ts">
	import type { ItemDetail } from '@atlas/contracts';
	import StatusChip from '../../lib/components/StatusChip.svelte';
	import { formatClock, formatSpan } from '../shared/time';
	import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeft';
	import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeft';
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRight';
	import ArrowUUpLeftIcon from 'phosphor-svelte/lib/ArrowUUpLeft';
	import ArrowUUpRightIcon from 'phosphor-svelte/lib/ArrowUUpRight';
	import SparkleIcon from 'phosphor-svelte/lib/Sparkle';

	let {
		detail,
		pending,
		dirty,
		canUndo,
		canRedo,
		onundo,
		onredo,
		canFindSimilar,
		onfindsimilar,
		onleave,
		onneighbour
	}: {
		detail: ItemDetail;
		/** Items still waiting in the project queue. */
		pending: number;
		dirty: boolean;
		canUndo: boolean;
		canRedo: boolean;
		onundo: () => void;
		onredo: () => void;
		/** The project's search can find items like this one. */
		canFindSimilar: boolean;
		onfindsimilar: () => void;
		onleave: () => void;
		onneighbour: (offset: 1 | -1) => void;
	} = $props();

	const title = $derived.by(() => {
		if (detail.asset.title !== undefined) {
			return detail.asset.title;
		}
		return detail.asset.id;
	});
</script>

<header class="border-line flex items-center gap-3 border-b px-4 py-2">
	<button type="button" class="btn btn-ghost btn-sm btn-square" onclick={onleave} aria-label="Back to the queue" title="Back to the queue">
		<ArrowLeftIcon size={15} />
	</button>
	<div class="min-w-0">
		<div class="text-default truncate text-[length:calc(15px*var(--text-scale))] font-semibold" {title}>{title}</div>
		<div class="text-dim flex items-center gap-2 font-mono text-xs">
			{#if detail.item.span}<span>{formatSpan(detail.item.span)}</span>{/if}
			{#if detail.asset.duration !== undefined}<span>of {formatClock(detail.asset.duration)}</span>{/if}
			{#if detail.asset.width && detail.asset.height}<span>{detail.asset.width}×{detail.asset.height}</span>{/if}
		</div>
	</div>
	<StatusChip status={detail.status} />
	{#if dirty}<span class="badge bg-amber-soft text-amber">unsaved</span>{/if}
	<div class="ml-auto flex items-center gap-2">
		{#if canFindSimilar}
			<button type="button" tabindex="-1" class="btn btn-ghost btn-sm" onmousedown={(event) => event.preventDefault()} onclick={onfindsimilar} title="Items like this one, in the queue (leader s)">
				<SparkleIcon size={14} /> Find similar
			</button>
		{/if}
		<div class="flex items-center">
			<button type="button" tabindex="-1" class="btn btn-ghost btn-sm btn-square" disabled={!canUndo} onmousedown={(event) => event.preventDefault()} onclick={onundo} aria-label="Undo" title="Undo (Ctrl+Z)">
				<ArrowUUpLeftIcon size={15} />
			</button>
			<button type="button" tabindex="-1" class="btn btn-ghost btn-sm btn-square" disabled={!canRedo} onmousedown={(event) => event.preventDefault()} onclick={onredo} aria-label="Redo" title="Redo (Ctrl+Shift+Z)">
				<ArrowUUpRightIcon size={15} />
			</button>
		</div>
		<span class="text-dim text-sm"><span class="text-default font-semibold">{pending}</span> pending</span>
		<button type="button" class="btn btn-ghost btn-sm btn-square" disabled={detail.previous === undefined} onclick={() => onneighbour(-1)} aria-label="Previous scene of this video" title="Previous scene (Shift+←)">
			<CaretLeftIcon size={14} />
		</button>
		<button type="button" class="btn btn-ghost btn-sm btn-square" disabled={detail.next === undefined} onclick={() => onneighbour(1)} aria-label="Next scene of this video" title="Next scene (Shift+→)">
			<CaretRightIcon size={14} />
		</button>
	</div>
</header>
