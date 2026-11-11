<script lang="ts">
	// The item on a zoomable time axis: a filmstrip ruler with a large hover preview, and one track per
	// label that is on, suggested as a range, or armed. Dragging in a track draws a range; bars move
	// and resize by dragging, select on click, loop on double-click. Times on screen are asset seconds;
	// ranges are stored item-relative.
	import type { Asset, Group, Range, Span } from '@atlas/contracts';
	import type { MediaPlayerContribution } from '@atlas/contracts/web';
	import MagnifyingGlassMinusIcon from 'phosphor-svelte/lib/MagnifyingGlassMinus';
	import MagnifyingGlassPlusIcon from 'phosphor-svelte/lib/MagnifyingGlassPlus';
	import ArrowsOutLineHorizontalIcon from 'phosphor-svelte/lib/ArrowsOutLineHorizontal';
	import RepeatIcon from 'phosphor-svelte/lib/Repeat';
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import type { PendingRange, RangeTarget } from './ranges';
	import type { LabelTrack, RangeDragMode, SuggestedRange, TimelineWindow } from './timeline';
	import { draggedRange, pageTo, panWindow, percentAt, secondsAtFraction, snapTime, tickStep, ticksOf, timelineWindow, zoomWindow } from './timeline';
	import { formatClock } from '../shared/time';

	let {
		asset,
		media,
		itemSpan,
		trimmed,
		playhead,
		frameRate,
		tracks,
		pending,
		itemStart,
		length,
		selected,
		looped,
		onseek,
		onselect,
		onloop,
		oncreate,
		onchange,
		onaccept,
		onarm,
		selectedRefinements,
		onrefine,
		ondelete
	}: {
		asset: Asset;
		media: MediaPlayerContribution | undefined;
		/** The item's own span (or the whole asset). */
		itemSpan: Span;
		trimmed: Span | undefined;
		/** Asset seconds. */
		playhead: number;
		frameRate: number;
		tracks: LabelTrack[];
		pending: PendingRange | undefined;
		itemStart: number;
		/** Item length in seconds, when known. */
		length: number | undefined;
		selected: Range | undefined;
		looped: Range | undefined;
		onseek: (seconds: number) => void;
		onselect: (range: Range | undefined) => void;
		onloop: (range: Range) => void;
		oncreate: (target: RangeTarget, firstSeconds: number, secondSeconds: number) => void;
		onchange: (previous: Range, next: Range) => void;
		onaccept: (ghost: SuggestedRange) => void;
		onarm: (target: RangeTarget) => void;
		/** Refinement groups of the selected range's label, with the labels set for exactly its span. */
		selectedRefinements: { group: Group; chosen: string[]; wholeItem: string[] }[];
		onrefine: (target: RangeTarget) => void;
		ondelete: (range: Range) => void;
	} = $props();

	const PREVIEW_WIDTH = 384;
	const FILMSTRIP_CELL_PIXELS = 88;
	const SNAP_PIXELS = 6;
	/** Pointer travel below this is a click, not a drag. */
	const CLICK_PIXELS = 3;

	type Drag =
		| { kind: 'scrub' }
		| { kind: 'create'; target: RangeTarget; anchor: number; current: number; startX: number }
		| { kind: 'edit'; range: Range; mode: RangeDragMode; origin: number; preview: Range; startX: number };

	let container = $state<HTMLElement>();
	let ruler = $state<HTMLElement>();
	let laneWidth = $state(0);
	let containerWidth = $state(0);
	let view = $state<TimelineWindow | undefined>(undefined);
	let hover = $state<{ seconds: number; x: number } | undefined>(undefined);
	let drag = $state.raw<Drag | undefined>(undefined);
	let lastPlayhead = 0;

	const fitted = $derived(timelineWindow(itemSpan, trimmed, asset.duration));
	const bounds = $derived.by((): TimelineWindow => {
		if (asset.duration !== undefined && asset.duration > 0) {
			return { start: 0, end: asset.duration };
		}
		return fitted;
	});
	const axis = $derived.by(() => {
		if (view !== undefined) {
			return view;
		}
		return fitted;
	});
	const ticks = $derived(ticksOf(axis, tickStep(axis, laneWidth)));
	const tickDecimals = $derived.by(() => {
		if (tickStep(axis, laneWidth) < 1) {
			return 1;
		}
		return 0;
	});
	const filmstripCount = $derived(Math.max(1, Math.floor(laneWidth / FILMSTRIP_CELL_PIXELS)));
	const secondsPerPixel = $derived((axis.end - axis.start) / Math.max(1, laneWidth));
	const zoomed = $derived(view !== undefined);

	// A new item starts fitted to its span.
	$effect(() => {
		void itemSpan.start;
		void itemSpan.end;
		view = undefined;
	});

	// While zoomed in, playback that runs off the right edge pages the view along.
	$effect(() => {
		const current = view;
		const at = playhead;
		const wasInside = lastPlayhead >= axis.start && lastPlayhead <= axis.end;
		lastPlayhead = at;
		if (current === undefined || drag !== undefined || !wasInside || at <= current.end) {
			return;
		}
		view = pageTo(current, bounds, at);
	});

	// Wheel zooms around the pointer, Shift+wheel or a horizontal swipe pans; needs a non-passive listener.
	$effect(() => {
		const element = container;
		if (element === undefined) {
			return;
		}
		element.addEventListener('wheel', onWheel, { passive: false });
		return () => element.removeEventListener('wheel', onWheel);
	});

	function onWheel(event: WheelEvent): void {
		event.preventDefault();
		const horizontal = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
		if (horizontal) {
			view = panWindow(axis, bounds, panPixels(event) * secondsPerPixel);
		} else {
			view = zoomWindow(axis, bounds, zoomAnchor(), Math.exp(event.deltaY * 0.0015));
		}
		// The pointer stays put while the axis moves under it.
		if (hover !== undefined) {
			hover = { ...hover, seconds: secondsAtClientX(event.clientX) };
		}
	}

	function zoomAnchor(): number {
		if (hover !== undefined) {
			return hover.seconds;
		}
		return (axis.start + axis.end) / 2;
	}

	/** Mice send Shift+wheel as vertical delta, trackpads swipe horizontally. */
	function panPixels(event: WheelEvent): number {
		if (event.shiftKey) {
			return event.deltaX + event.deltaY;
		}
		return event.deltaX;
	}

	function zoomBy(factor: number): void {
		view = zoomWindow(axis, bounds, playhead, factor);
	}

	function fit(): void {
		view = undefined;
	}

	// --- geometry ------------------------------------------------------------------------

	function secondsAtClientX(clientX: number): number {
		if (ruler === undefined) {
			return axis.start;
		}
		const box = ruler.getBoundingClientRect();
		return secondsAtFraction(axis, (clientX - box.left) / box.width);
	}

	function snapped(seconds: number): number {
		return snapTime(seconds, playhead, SNAP_PIXELS * secondsPerPixel, frameRate);
	}

	function left(seconds: number): number {
		return percentAt(axis, seconds);
	}

	function widthBetween(start: number, end: number): number {
		return percentAt(axis, end) - percentAt(axis, start);
	}

	function updateHover(event: PointerEvent): void {
		if (container === undefined || ruler === undefined) {
			return;
		}
		const box = ruler.getBoundingClientRect();
		if (event.clientX < box.left || event.clientX > box.right) {
			hover = undefined;
			return;
		}
		const containerBox = container.getBoundingClientRect();
		hover = { seconds: secondsAtClientX(event.clientX), x: event.clientX - containerBox.left };
	}

	const previewLeft = $derived.by(() => {
		if (hover === undefined) {
			return 0;
		}
		return Math.min(Math.max(0, hover.x - PREVIEW_WIDTH / 2), Math.max(0, containerWidth - PREVIEW_WIDTH));
	});

	// --- dragging --------------------------------------------------------------------------

	function follow(onmove: (event: PointerEvent) => void, onup: (event: PointerEvent) => void): void {
		const move = (event: PointerEvent) => onmove(event);
		const up = (event: PointerEvent) => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			onup(event);
			drag = undefined;
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	}

	function startScrub(event: PointerEvent): void {
		if (event.button !== 0) {
			return;
		}
		event.preventDefault();
		drag = { kind: 'scrub' };
		onseek(secondsAtClientX(event.clientX));
		follow(
			(move) => onseek(secondsAtClientX(move.clientX)),
			() => undefined
		);
	}

	function startCreate(event: PointerEvent, track: LabelTrack): void {
		if (event.button !== 0 || event.target !== event.currentTarget) {
			return;
		}
		event.preventDefault();
		const target = { group: track.group.id, label: track.label.id };
		const anchor = snapped(secondsAtClientX(event.clientX));
		drag = { kind: 'create', target, anchor, current: anchor, startX: event.clientX };
		follow(
			(move) => {
				if (drag?.kind === 'create') {
					drag = { ...drag, current: snapped(secondsAtClientX(move.clientX)) };
				}
			},
			(up) => finishCreate(up, target, anchor)
		);
	}

	function finishCreate(event: PointerEvent, target: RangeTarget, anchor: number): void {
		const current = drag;
		if (current === undefined || current.kind !== 'create') {
			return;
		}
		if (Math.abs(event.clientX - current.startX) < CLICK_PIXELS) {
			onarm(target);
			onselect(undefined);
			onseek(secondsAtClientX(event.clientX));
			return;
		}
		oncreate(target, anchor, current.current);
	}

	function startEdit(event: PointerEvent, range: Range, mode: RangeDragMode): void {
		if (event.button !== 0) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const origin = secondsAtClientX(event.clientX);
		drag = { kind: 'edit', range, mode, origin, preview: range, startX: event.clientX };
		follow(
			(move) => moveEdit(move, range, mode, origin),
			(up) => finishEdit(up, range)
		);
	}

	function moveEdit(event: PointerEvent, range: Range, mode: RangeDragMode, origin: number): void {
		if (drag === undefined || drag.kind !== 'edit') {
			return;
		}
		const preview = draggedRange(range, mode, secondsAtClientX(event.clientX) - origin, length);
		const snappedPreview = snapEdges(preview, mode);
		drag = { ...drag, preview: snappedPreview };
		seekToEdge(snappedPreview, mode);
	}

	/** Snaps the edge being dragged (both edges keep their distance when moving the bar). */
	function snapEdges(range: Range, mode: RangeDragMode): Range {
		if (mode === 'end') {
			return draggedRange(range, 'end', snapped(itemStart + range.end) - itemStart - range.end, length);
		}
		return draggedRange(range, mode, snapped(itemStart + range.start) - itemStart - range.start, length);
	}

	// Shows the frame under the edge being dragged, so it can be placed exactly.
	function seekToEdge(range: Range, mode: RangeDragMode): void {
		if (mode === 'end') {
			onseek(itemStart + range.end);
			return;
		}
		onseek(itemStart + range.start);
	}

	function finishEdit(event: PointerEvent, range: Range): void {
		const current = drag;
		if (current === undefined || current.kind !== 'edit') {
			return;
		}
		if (Math.abs(event.clientX - current.startX) < CLICK_PIXELS) {
			onselect(range);
			onseek(itemStart + range.start);
			return;
		}
		onchange(range, current.preview);
	}

	// --- drawing helpers -------------------------------------------------------------------

	function shownRange(range: Range): Range {
		if (drag !== undefined && drag.kind === 'edit' && drag.range === range) {
			return drag.preview;
		}
		return range;
	}

	function creatingIn(track: LabelTrack): { start: number; end: number } | undefined {
		if (drag === undefined || drag.kind !== 'create') {
			return undefined;
		}
		if (drag.target.group !== track.group.id || drag.target.label !== track.label.id) {
			return undefined;
		}
		return { start: Math.min(drag.anchor, drag.current), end: Math.max(drag.anchor, drag.current) };
	}

	function pendingIn(track: LabelTrack): { start: number; end: number } | undefined {
		if (pending === undefined || pending.group !== track.group.id || pending.label !== track.label.id) {
			return undefined;
		}
		const start = itemStart + pending.start;
		return { start: Math.min(start, playhead), end: Math.max(start, playhead) };
	}

	function wholeSpan(): Span {
		if (trimmed !== undefined) {
			return trimmed;
		}
		return itemSpan;
	}

	function describe(range: Range): string {
		return `${range.group}.${range.label}: ${formatClock(range.start, 2)}–${formatClock(range.end, 2)} of the item`;
	}

	function barClass(range: Range): string {
		const classes = ['bg-violet/60 hover:bg-violet/75'];
		if (range === selected) {
			classes.push('ring-2 ring-white/90 z-10');
		}
		if (range === looped) {
			classes.push('bg-amber/70 hover:bg-amber/80');
		}
		return classes.join(' ');
	}

	function refinementTitle(name: string, wholeItem: boolean): string {
		if (wholeItem) {
			return `${name} is set for the whole item (in the panel)`;
		}
		return `Set ${name} for exactly this part`;
	}

	function selectedName(range: Range): string {
		const track = tracks.find((candidate) => candidate.group.id === range.group && candidate.label.id === range.label);
		if (track === undefined) {
			return range.label;
		}
		return track.label.name;
	}

	function trackTitle(track: LabelTrack): string {
		if (track.whole) {
			return `${track.group.label}: ${track.label.name}, for the entire scene. Drag inside the track to mark only the parts where it happens.`;
		}
		return `${track.group.label}: ${track.label.name}. Drag in the track to add a range.`;
	}
</script>

<div
	bind:this={container}
	bind:clientWidth={containerWidth}
	class="relative flex flex-col gap-1 select-none"
	style="--gutter: 9rem"
	onpointermove={updateHover}
	onpointerleave={() => (hover = undefined)}
	role="group"
	aria-label="Timeline"
>
	{#if hover && media?.frame && drag?.kind !== 'scrub'}
		<div class="border-line pointer-events-none absolute bottom-full z-30 mb-2 overflow-hidden rounded-md border bg-black shadow-xl" style="left: {previewLeft}px; width: {PREVIEW_WIDTH}px">
			<div class="aspect-video w-full">
				<media.frame {asset} seconds={hover.seconds} />
			</div>
			<div class="bg-black/80 px-2 py-0.5 text-center font-mono text-[11px] text-white tabular-nums">{formatClock(hover.seconds, 2)}</div>
		</div>
	{/if}

	<!-- ruler: filmstrip, item span, trim, ticks -->
	<div class="grid grid-cols-[var(--gutter)_1fr] items-stretch gap-2">
		<div class="text-dim flex flex-col justify-center text-right font-mono text-[11px] leading-tight tabular-nums">
			<span class="text-default">{formatClock(playhead, 2)}</span>
			<span>f{Math.floor(playhead * frameRate + 1e-3)} · {Math.round(frameRate * 100) / 100} fps</span>
		</div>
		<div
			bind:this={ruler}
			bind:clientWidth={laneWidth}
			role="slider"
			tabindex="-1"
			aria-label="Seek"
			aria-valuenow={playhead}
			onpointerdown={startScrub}
			class="border-line bg-surface relative h-[4.25rem] cursor-col-resize overflow-hidden rounded-md border"
		>
			{#if media?.filmstrip}
				<div class="pointer-events-none absolute inset-x-0 top-0 h-12 opacity-80">
					<media.filmstrip {asset} start={axis.start} end={axis.end} count={filmstripCount} />
				</div>
			{/if}
			<div class="pointer-events-none absolute top-0 left-0 h-12 bg-black/55" style="width: {left(itemSpan.start)}%"></div>
			<div class="pointer-events-none absolute top-0 right-0 h-12 bg-black/55" style="width: {100 - left(itemSpan.end)}%"></div>
			<div class="border-blue pointer-events-none absolute top-0 h-12 border-x-2" style="left: {left(itemSpan.start)}%; width: {widthBetween(itemSpan.start, itemSpan.end)}%" title="Item span"></div>
			{#if trimmed}
				<div class="border-amber pointer-events-none absolute top-1 h-10 border-x-2 border-dashed" style="left: {left(trimmed.start)}%; width: {widthBetween(trimmed.start, trimmed.end)}%" title="Trimmed span"></div>
			{/if}
			<div class="pointer-events-none absolute inset-x-0 bottom-0 h-[1.1rem] bg-black/40">
				{#each ticks as tick (tick)}
					<div class="absolute bottom-0 h-full border-l border-white/20" style="left: {left(tick)}%">
						<span class="text-dim absolute bottom-0.5 left-1 font-mono text-[10px] whitespace-nowrap">{formatClock(tick, tickDecimals)}</span>
					</div>
				{/each}
			</div>
		</div>
	</div>

	<!-- one track per label -->
	{#each tracks as track (`${track.group.id}.${track.label.id}`)}
		{@const creating = creatingIn(track)}
		{@const drawing = pendingIn(track)}
		<div class="grid grid-cols-[var(--gutter)_1fr] items-center gap-2">
			<button
				type="button"
				tabindex="-1"
				onmousedown={(event) => event.preventDefault()}
				onclick={() => onarm({ group: track.group.id, label: track.label.id })}
				title={trackTitle(track)}
				class="flex min-w-0 items-center justify-end gap-1 text-right text-[11px] leading-tight {track.armed ? 'text-default' : 'text-dim hover:text-muted'}"
			>
				{#if track.refines}
					<span class="text-violet">↳</span>
				{:else}
					<span class="text-faint truncate">{track.group.label}</span>
				{/if}
				<span class="truncate font-medium">{track.label.name}</span>
				{#if track.armed}<span class="bg-violet h-1.5 w-1.5 shrink-0 rounded-full" title="Armed: R and dragging use this label"></span>{/if}
			</button>
			<div
				role="presentation"
				onpointerdown={(event) => startCreate(event, track)}
				class="bg-surface relative cursor-crosshair rounded {track.refines ? 'h-5' : 'h-6'} {track.armed ? 'ring-violet/50 ring-1' : ''}"
				title={trackTitle(track)}
			>
				{#if track.whole}
					<div class="bg-violet/25 border-violet/50 pointer-events-none absolute inset-y-0.5 flex items-center rounded-sm border border-dashed gap-1 overflow-hidden px-1.5 text-[11px] whitespace-nowrap text-white" style="left: {left(wholeSpan().start)}%; width: {widthBetween(wholeSpan().start, wholeSpan().end)}%">
						<span class="font-medium">{track.label.name}</span>
						{#if track.wholeNote}<span class="text-white/80">· {track.wholeNote}</span>{/if}
						{#if track.armed}<span class="ml-auto pl-2 text-white/40">entire scene · drag inside to mark only parts</span>{/if}
					</div>
				{/if}

				{#each track.ghosts as ghost (ghost)}
					<button
						type="button"
						tabindex="-1"
						onmousedown={(event) => event.preventDefault()}
						onpointerdown={(event) => event.stopPropagation()}
						onclick={() => onaccept(ghost)}
						title="Suggested ({Math.round(ghost.score * 100)} %): click to take it"
						class="border-violet text-violet hover:bg-violet/20 absolute inset-y-0.5 overflow-hidden rounded-sm border border-dashed px-1 text-left text-[10px] leading-4 whitespace-nowrap"
						style="left: {left(itemStart + ghost.start)}%; width: {widthBetween(itemStart + ghost.start, itemStart + ghost.end)}%"
					>
						{Math.round(ghost.score * 100)} %
					</button>
				{/each}

				{#each track.ranges as range, index (range)}
					{@const shown = shownRange(range)}
					{@const note = track.rangeNotes[index]}
					<div
						role="button"
						tabindex="-1"
						title="{describe(shown)}. Drag to move, edges to resize, double-click to loop it."
						onpointerdown={(event) => startEdit(event, range, 'move')}
						ondblclick={() => onloop(range)}
						class="absolute inset-y-0 cursor-grab overflow-hidden rounded-sm {barClass(range)}"
						style="left: {left(itemStart + shown.start)}%; width: {widthBetween(itemStart + shown.start, itemStart + shown.end)}%"
					>
						<span class="pointer-events-none flex h-full items-center gap-1 px-1.5 text-[11px] whitespace-nowrap text-white">
							<span class="font-medium">{track.label.name}</span>
							{#if note}<span class="text-white/80">· {note}</span>{/if}
							<span class="opacity-60">{formatClock(shown.end - shown.start, 1)}</span>
						</span>
						<div role="presentation" class="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-white/0 hover:bg-white/50" onpointerdown={(event) => startEdit(event, range, 'start')}></div>
						<div role="presentation" class="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-white/0 hover:bg-white/50" onpointerdown={(event) => startEdit(event, range, 'end')}></div>
					</div>
				{/each}

				{#if creating}
					<div class="bg-violet/40 border-violet pointer-events-none absolute inset-y-0 rounded-sm border" style="left: {left(creating.start)}%; width: {widthBetween(creating.start, creating.end)}%"></div>
				{/if}
				{#if drawing}
					<div class="border-violet bg-violet/20 pointer-events-none absolute inset-y-0 border-l-2 border-dashed" style="left: {left(drawing.start)}%; width: {widthBetween(drawing.start, drawing.end)}%"></div>
				{/if}
			</div>
		</div>
	{/each}

	{#if tracks.length === 0}
		<div class="grid grid-cols-[var(--gutter)_1fr] gap-2">
			<span></span>
			<span class="text-faint border-line rounded border border-dashed px-2 py-1 text-[11px]">Pick a label on the right: its track shows up here, and dragging in it limits the label to a range.</span>
		</div>
	{/if}

	<!-- playhead and hover line across ruler and tracks -->
	<div class="pointer-events-none absolute inset-y-0 z-20 w-px bg-white" style="left: calc(var(--gutter) + 0.5rem + (100% - var(--gutter) - 0.5rem) * {left(playhead) / 100})"></div>
	{#if hover}
		<div class="pointer-events-none absolute inset-y-0 z-20 w-px bg-white/30" style="left: {hover.x}px"></div>
	{/if}

	<div class="text-faint grid grid-cols-[var(--gutter)_1fr] items-center gap-2 text-[11px]">
		<div class="flex justify-end gap-0.5">
			<button type="button" tabindex="-1" class="btn btn-ghost btn-xs btn-square" onmousedown={(event) => event.preventDefault()} onclick={() => zoomBy(1.6)} title="Zoom out (wheel)"><MagnifyingGlassMinusIcon size={14} /></button>
			<button type="button" tabindex="-1" class="btn btn-ghost btn-xs btn-square" onmousedown={(event) => event.preventDefault()} onclick={() => zoomBy(1 / 1.6)} title="Zoom in around the playhead (wheel)"><MagnifyingGlassPlusIcon size={14} /></button>
			<button type="button" tabindex="-1" class="btn btn-ghost btn-xs btn-square" disabled={!zoomed} onmousedown={(event) => event.preventDefault()} onclick={fit} title="Fit the item"><ArrowsOutLineHorizontalIcon size={14} /></button>
		</div>
		{#if selected}
			<div class="flex min-w-0 flex-wrap items-center gap-1.5">
				<span class="text-default font-medium">{selectedName(selected)}</span>
				<span class="font-mono tabular-nums">{formatClock(itemStart + selected.start, 2)}–{formatClock(itemStart + selected.end, 2)}</span>
				{#each selectedRefinements as refinement (refinement.group.id)}
					<span class="bg-line mx-1 h-3 w-px"></span>
					<span>{refinement.group.label}:</span>
					{#each refinement.group.labels.filter((label) => label.deprecated !== true) as label (label.id)}
						<button
							type="button"
							tabindex="-1"
							onmousedown={(event) => event.preventDefault()}
							onclick={() => onrefine({ group: refinement.group.id, label: label.id })}
							disabled={refinement.wholeItem.includes(label.id)}
							class="btn btn-xs {refinement.chosen.includes(label.id) || refinement.wholeItem.includes(label.id) ? 'btn-primary' : 'btn-ghost border-line'}"
							title={refinementTitle(label.name, refinement.wholeItem.includes(label.id))}
						>
							{label.name}
						</button>
					{/each}
				{/each}
				<span class="bg-line mx-1 h-3 w-px"></span>
				<button type="button" tabindex="-1" class="btn btn-ghost btn-xs" onmousedown={(event) => event.preventDefault()} onclick={() => onloop(selected)} title="Loop just this part (double-click)">
					<RepeatIcon size={12} />{#if selected === looped}Stop loop{:else}Loop{/if}
				</button>
				<button type="button" tabindex="-1" class="btn btn-ghost btn-xs" onmousedown={(event) => event.preventDefault()} onclick={() => ondelete(selected)} title="Delete this part (Backspace)">
					<TrashIcon size={12} />Delete
				</button>
			</div>
		{:else}
			<span class="truncate">Drag in a track to mark where a label holds · click a bar to edit it · <span class="font-mono">?</span> for all keys</span>
		{/if}
	</div>
</div>
