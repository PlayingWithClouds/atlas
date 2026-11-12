<script lang="ts">
	import type { ItemView } from '@atlas/contracts';
	import { kernelContext } from '../../kernel/context';
	import StatusChip from '../../lib/components/StatusChip.svelte';
	import { formatSpan } from '../shared/time';
	import { labelPath } from './itemLink';
	import ArrowCounterClockwiseIcon from 'phosphor-svelte/lib/ArrowCounterClockwise';
	import CheckIcon from 'phosphor-svelte/lib/Check';
	import EyeSlashIcon from 'phosphor-svelte/lib/EyeSlash';

	let {
		projectId,
		view,
		search = '',
		selected,
		selecting,
		onselect,
		onskip,
		onrestore
	}: {
		projectId: string;
		view: ItemView;
		/** Query string the labeling screen keeps (the queue's filters). */
		search?: string;
		selected: boolean;
		/** Some card is selected: a click on a card selects it instead of opening it. */
		selecting: boolean;
		/** Toggles the selection; `extend` is true when Shift was held. */
		onselect: (extend: boolean) => void;
		onskip: () => void;
		onrestore: () => void;
	} = $props();

	const ctx = kernelContext();

	const media = $derived(ctx.mediaPlayers.list().find((candidate) => candidate.kind === view.asset.kind));
	const poster = $derived.by(() => {
		if (view.item.poster !== undefined) {
			return view.item.poster;
		}
		return view.asset.poster;
	});
	const title = $derived.by(() => {
		if (view.asset.title !== undefined) {
			return view.asset.title;
		}
		return view.asset.id;
	});
	const checkboxLook = $derived.by(() => {
		if (selected) {
			return 'bg-action border-action text-action-fg opacity-100';
		}
		if (selecting) {
			return 'border-white/70 bg-black/40 opacity-100';
		}
		return 'border-white/70 bg-black/40 opacity-0 group-hover:opacity-100';
	});

	function onCardClick(event: MouseEvent) {
		if (!selecting && !event.shiftKey) {
			return;
		}
		event.preventDefault();
		onselect(event.shiftKey);
	}

	/** Buttons sit inside the card's link; they must neither follow it nor select the card. */
	function runInstead(event: MouseEvent, action: () => void) {
		event.stopPropagation();
		event.preventDefault();
		action();
	}
</script>

<a
	href={labelPath(projectId, view.item.id) + search}
	onclick={onCardClick}
	class="bg-surface group relative flex flex-col overflow-hidden rounded-lg border transition-colors {selected ? 'border-action' : 'border-line hover:border-line-strong'}"
>
	{#if media}
		<media.preview asset={view.asset} span={view.item.span} {poster} />
	{:else if poster}
		<img src={poster} alt="" loading="lazy" class="aspect-video w-full object-cover" />
	{:else}
		<div class="bg-canvas aspect-video w-full"></div>
	{/if}

	<button
		type="button"
		onclick={(event) => runInstead(event, () => onselect(event.shiftKey))}
		aria-label="Select"
		aria-pressed={selected}
		class="absolute top-2 left-2 z-10 flex h-5 w-5 items-center justify-center rounded border transition-opacity {checkboxLook}"
	>
		{#if selected}<CheckIcon size={12} weight="bold" />{/if}
	</button>

	{#if view.status === 'pending' && !selecting}
		<button type="button" onclick={(event) => runInstead(event, onskip)} title="Skip: take it out of the queue" class="card-action">
			<EyeSlashIcon size={12} /> Skip
		</button>
	{:else if view.status === 'skipped' && !selecting}
		<button type="button" onclick={(event) => runInstead(event, onrestore)} title="Back to pending" class="card-action">
			<ArrowCounterClockwiseIcon size={12} /> Restore
		</button>
	{/if}

	<div class="flex flex-col gap-1.5 p-2.5">
		<div class="text-default truncate text-sm font-medium" title={title}>{title}</div>
		<div class="flex items-center gap-2">
			<StatusChip status={view.status} />
			{#if view.item.span}
				<span class="text-dim font-mono text-2xs">{formatSpan(view.item.span)}</span>
			{/if}
			{#if view.match !== undefined}
				<span class="badge badge-sm badge-outline font-mono" title="How well it matches the filter (model probability, or description match)">{Math.round(view.match * 100)}%</span>
			{/if}
			{#if view.priority !== undefined}
				<span class="text-faint ml-auto font-mono text-2xs" title="Priority">p {view.priority.toFixed(2)}</span>
			{/if}
		</div>
	</div>
</a>

<style>
	.card-action {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
		z-index: 10;
		display: flex;
		align-items: center;
		gap: 0.25rem;
		border-radius: 0.375rem;
		background: rgb(0 0 0 / 0.7);
		padding: 0.25rem 0.5rem;
		font-size: 0.75rem;
		color: white;
		opacity: 0;
		transition: opacity 120ms;
	}

	:global(.group:hover) > .card-action {
		opacity: 1;
	}

	.card-action:hover {
		background: rgb(0 0 0 / 0.9);
	}
</style>
