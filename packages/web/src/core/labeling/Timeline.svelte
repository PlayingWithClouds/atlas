<script lang="ts">
	import type { Group, Range, Span } from '@atlas/contracts';
	import type { PendingRange } from './ranges';
	import { percentAt, rangeRows, secondsAtFraction, timelineWindow } from './timeline';
	import { formatClock } from '../shared/time';

	let {
		itemSpan,
		trimmed,
		duration,
		playhead,
		groups,
		ranges,
		pending,
		itemStart,
		onseek,
		ondelete
	}: {
		/** The item's own span (or the whole asset). */
		itemSpan: Span;
		trimmed: Span | undefined;
		duration: number | undefined;
		/** Asset seconds. */
		playhead: number;
		groups: Group[];
		ranges: Range[];
		pending: PendingRange | undefined;
		itemStart: number;
		onseek: (seconds: number) => void;
		ondelete: (range: Range) => void;
	} = $props();

	let track = $state<HTMLElement>();

	const axis = $derived(timelineWindow(itemSpan, trimmed, duration));
	const rows = $derived(rangeRows(groups, ranges, axis, itemStart, pending?.group));
	const spanLeft = $derived(percentAt(axis, itemSpan.start));
	const spanWidth = $derived(percentAt(axis, itemSpan.end) - spanLeft);
	const playheadLeft = $derived(percentAt(axis, playhead));

	function seekFromPointer(event: PointerEvent) {
		if (track === undefined) return;
		const box = track.getBoundingClientRect();
		onseek(secondsAtFraction(axis, (event.clientX - box.left) / box.width));
	}

	function pendingBar(request: PendingRange): { left: number; width: number } {
		const left = percentAt(axis, itemStart + request.start);
		const right = Math.max(left, percentAt(axis, playhead));
		return { left, width: right - left };
	}

	function describe(range: Range): string {
		return `${range.group}.${range.label}: ${formatClock(range.start, 1)}–${formatClock(range.end, 1)} (click to delete)`;
	}
</script>

<div class="flex flex-col gap-1">
	<div
		bind:this={track}
		role="slider"
		tabindex="-1"
		aria-label="Timeline"
		aria-valuenow={playhead}
		onpointerdown={seekFromPointer}
		class="border-line bg-surface relative h-9 cursor-pointer overflow-hidden rounded-md border"
	>
		<div class="bg-blue-soft border-blue absolute inset-y-0 border-x" style="left: {spanLeft}%; width: {spanWidth}%" title="Item span"></div>
		{#if trimmed}
			<div class="bg-amber-soft border-amber absolute inset-y-1 border-x-2" style="left: {percentAt(axis, trimmed.start)}%; width: {percentAt(axis, trimmed.end) - percentAt(axis, trimmed.start)}%" title="Trimmed span"></div>
		{/if}
		<div class="bg-default pointer-events-none absolute inset-y-0 w-px" style="left: {playheadLeft}%"></div>
		<span class="text-faint pointer-events-none absolute bottom-0.5 left-1 font-mono text-[10px]">{formatClock(axis.start)}</span>
		<span class="text-faint pointer-events-none absolute right-1 bottom-0.5 font-mono text-[10px]">{formatClock(axis.end)}</span>
	</div>

	{#each rows as row (row.group.id)}
		<div class="bg-surface relative h-5 rounded">
			{#each row.bars as bar (bar.range)}
				<button
					type="button"
					tabindex="-1"
					onmousedown={(event) => event.preventDefault()}
					onclick={() => ondelete(bar.range)}
					title={describe(bar.range)}
					class="bg-violet/60 hover:bg-red/70 text-default absolute inset-y-0 overflow-hidden rounded-sm px-1 text-left text-[10px] leading-5 whitespace-nowrap"
					style="left: {bar.left}%; width: {bar.width}%"
					aria-label={describe(bar.range)}
				>
					{bar.range.label}
				</button>
			{/each}
			{#if pending && pending.group === row.group.id}
				<div class="border-violet absolute inset-y-0 border-l-2 border-dashed" style="left: {pendingBar(pending).left}%; width: {pendingBar(pending).width}%"></div>
			{/if}
		</div>
	{/each}
</div>
