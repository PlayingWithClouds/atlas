<script lang="ts">
	import type { ItemDetail } from '@atlas/contracts';
	import StatusChip from '../../lib/components/StatusChip.svelte';
	import { formatClock, formatSpan } from '../shared/time';
	import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeft';
	import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeft';
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRight';

	let {
		detail,
		pending,
		dirty,
		onleave,
		onneighbour
	}: {
		detail: ItemDetail;
		/** Items still waiting in the project queue. */
		pending: number;
		dirty: boolean;
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
		<span class="text-dim text-sm"><span class="text-default font-semibold">{pending}</span> pending</span>
		<button type="button" class="btn btn-ghost btn-sm btn-square" disabled={detail.previous === undefined} onclick={() => onneighbour(-1)} aria-label="Previous scene of this video" title="Previous scene (Shift+←)">
			<CaretLeftIcon size={14} />
		</button>
		<button type="button" class="btn btn-ghost btn-sm btn-square" disabled={detail.next === undefined} onclick={() => onneighbour(1)} aria-label="Next scene of this video" title="Next scene (Shift+→)">
			<CaretRightIcon size={14} />
		</button>
	</div>
</header>
