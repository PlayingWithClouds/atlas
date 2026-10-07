<script lang="ts">
	// Drag handles for a span's time range. The window shown is local to the clip
	// (its stored range plus a little context) — this trims a clip, it does not scrub
	// a two-hour video.
	import { MIN_SPAN_SECONDS, formatTime } from '$lib/session/clip';

	let {
		start,
		end,
		storedStart,
		storedEnd,
		duration,
		playhead = null,
		onChange
	}: {
		start: number;
		end: number;
		storedStart: number;
		storedEnd: number;
		duration: number;
		playhead?: number | null;
		onChange: (start: number, end: number) => void;
	} = $props();

	let track = $state<HTMLDivElement | null>(null);

	const context = $derived(Math.max(2, storedEnd - storedStart));
	const windowStart = $derived(Math.max(0, Math.min(storedStart, start) - context));
	const windowEnd = $derived.by(() => {
		const wanted = Math.max(storedEnd, end) + context;
		// ffprobe can fail, leaving duration 0 — then there is no upper bound to clamp to.
		if (duration > 0) return Math.min(wanted, duration);
		return wanted;
	});
	const windowSpan = $derived(Math.max(windowEnd - windowStart, MIN_SPAN_SECONDS));

	function toPercent(seconds: number): number {
		return ((seconds - windowStart) / windowSpan) * 100;
	}

	function toSeconds(clientX: number): number {
		if (!track) return start;
		const box = track.getBoundingClientRect();
		const ratio = (clientX - box.left) / Math.max(box.width, 1);
		const seconds = windowStart + Math.min(Math.max(ratio, 0), 1) * windowSpan;
		if (duration > 0) return Math.min(seconds, duration);
		return seconds;
	}

	type Drag = { kind: 'start' | 'end' | 'band'; grabOffset: number };
	let drag: Drag | null = null;

	function beginDrag(kind: Drag['kind'], event: PointerEvent) {
		event.preventDefault();
		event.stopPropagation();
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		drag = { kind, grabOffset: toSeconds(event.clientX) - start };
	}

	function onPointerMove(event: PointerEvent) {
		if (!drag) return;
		const seconds = toSeconds(event.clientX);
		if (drag.kind === 'start') {
			onChange(Math.min(seconds, end - MIN_SPAN_SECONDS), end);
			return;
		}
		if (drag.kind === 'end') {
			onChange(start, Math.max(seconds, start + MIN_SPAN_SECONDS));
			return;
		}
		// Move the whole window, keeping its length.
		const length = end - start;
		let nextStart = Math.max(0, seconds - drag.grabOffset);
		if (duration > 0) nextStart = Math.min(nextStart, duration - length);
		onChange(nextStart, nextStart + length);
	}

	function endDrag(event: PointerEvent) {
		if (!drag) return;
		(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
		drag = null;
	}
</script>

<div class="flex flex-col gap-1.5">
	<div
		bind:this={track}
		class="border-line bg-base-100 relative h-10 w-full rounded-md border select-none"
	>
		<!-- Where the clip currently sits on disk, for reference while dragging. -->
		<div
			class="bg-line absolute inset-y-0 opacity-40"
			style="left: {toPercent(storedStart)}%; width: {toPercent(storedEnd) - toPercent(storedStart)}%"
		></div>

		<div
			role="slider"
			tabindex="0"
			aria-label="Clip range"
			aria-valuemin={windowStart}
			aria-valuemax={windowEnd}
			aria-valuenow={start}
			class="bg-primary/25 border-primary absolute inset-y-0 cursor-grab border-x-2 active:cursor-grabbing"
			style="left: {toPercent(start)}%; width: {toPercent(end) - toPercent(start)}%"
			onpointerdown={(e) => beginDrag('band', e)}
			onpointermove={onPointerMove}
			onpointerup={endDrag}
			onpointercancel={endDrag}
		></div>

		{#each [['start', start], ['end', end]] as const as [kind, seconds] (kind)}
			<div
				role="slider"
				tabindex="0"
				aria-label="{kind === 'start' ? 'Clip start' : 'Clip end'}"
				aria-valuemin={windowStart}
				aria-valuemax={windowEnd}
				aria-valuenow={seconds}
				class="bg-primary absolute inset-y-0 w-2 -translate-x-1/2 cursor-ew-resize rounded"
				style="left: {toPercent(seconds)}%"
				onpointerdown={(e) => beginDrag(kind, e)}
				onpointermove={onPointerMove}
				onpointerup={endDrag}
				onpointercancel={endDrag}
			></div>
		{/each}

		{#if playhead !== null}
			<div class="bg-green absolute inset-y-0 w-px" style="left: {toPercent(playhead)}%"></div>
		{/if}
	</div>

	<div class="text-dim flex items-center gap-3 font-mono text-[11px]">
		<span>{formatTime(start)}</span>
		<span class="text-faint">→</span>
		<span>{formatTime(end)}</span>
		<span class="text-faint">{(end - start).toFixed(2)}s</span>
		<span class="text-faint ml-auto">[ ] start · {'{'} {'}'} end · 0 reset</span>
	</div>
</div>
