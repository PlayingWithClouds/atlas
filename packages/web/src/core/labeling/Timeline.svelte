<script lang="ts">
	// The item on a zoomable time axis: a filmstrip ruler with a large hover preview, and one track per
	// label that is on, suggested as a range, or armed. Dragging in a track draws a range; bars move
	// and resize by dragging, select on click, loop on double-click; Shift+drag erases. Hovering,
	// scrubbing and dragging snap to range edges (Alt: no snapping). Times on screen are asset
	// seconds; ranges are stored item-relative.
	import type { Asset, Group, Range, Span } from '@atlas/contracts';
	import type { MediaPlayerContribution } from '@atlas/contracts/web';
	import MagnifyingGlassMinusIcon from 'phosphor-svelte/lib/MagnifyingGlassMinus';
	import MagnifyingGlassPlusIcon from 'phosphor-svelte/lib/MagnifyingGlassPlus';
	import ArrowsOutLineHorizontalIcon from 'phosphor-svelte/lib/ArrowsOutLineHorizontal';
	import RepeatIcon from 'phosphor-svelte/lib/Repeat';
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import type { PendingRange, RangeTarget } from './ranges';
	import type { LabelTrack, RangeDragMode, SuggestedRange, TimelineWindow } from './timeline';
	import { draggedRange, nearestAnchor, pageTo, panWindow, percentAt, secondsAtFraction, snapToAnchors, tickStep, ticksOf, timelineWindow, zoomWindow } from './timeline';
	import { formatClock } from '../shared/time';
	import { settings } from '../settings/settings.svelte';
	import { untrack } from 'svelte';

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
		onerase,
		onchange,
		onaccept,
		onarm,
		selectedRefinements,
		onrefine,
		ondelete,
		onhover,
		onscrub,
		zoomRequest
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
		/** Labels started at the playhead, drawn from their start to the playhead. */
		pending: PendingRange[];
		itemStart: number;
		/** Item length in seconds, when known. */
		length: number | undefined;
		selected: Range | undefined;
		looped: Range | undefined;
		onseek: (seconds: number) => void;
		onselect: (range: Range | undefined) => void;
		onloop: (range: Range) => void;
		oncreate: (target: RangeTarget, firstSeconds: number, secondSeconds: number) => void;
		/** Shift+drag in a track: take that part out of the label. */
		onerase: (target: RangeTarget, firstSeconds: number, secondSeconds: number) => void;
		onchange: (previous: Range, next: Range) => void;
		onaccept: (ghost: SuggestedRange) => void;
		onarm: (target: RangeTarget) => void;
		/** Refinement groups of the selected range's label, with the labels set for exactly its span. */
		selectedRefinements: { group: Group; chosen: string[]; wholeItem: string[] }[];
		onrefine: (target: RangeTarget) => void;
		ondelete: (range: Range) => void;
		/** Asset seconds under the pointer while it hovers the timeline (not while dragging); the page previews that frame. */
		onhover: (seconds: number | undefined) => void;
		/** Scrubbing the ruler started: the player pauses so it stays where the pointer leaves it. */
		onscrub: () => void;
		/** Zoom by `factor` around the playhead each time `id` changes (keyboard + / -). */
		zoomRequest: { id: number; factor: number } | undefined;
	} = $props();

	const FILMSTRIP_CELL_PIXELS = 128;
	const SNAP_PIXELS = 8;
	/** Pointer travel below this is a click, not a drag. */
	const CLICK_PIXELS = 3;

	type Drag =
		| { kind: 'scrub' }
		| { kind: 'create'; target: RangeTarget; anchor: number; current: number; startX: number; erase: boolean }
		| { kind: 'edit'; range: Range; mode: RangeDragMode; origin: number; preview: Range; startX: number; snapTo: number };

	let container = $state<HTMLElement>();
	let ruler = $state<HTMLElement>();
	let laneWidth = $state(0);
	let view = $state<TimelineWindow | undefined>(undefined);
	/** Hovered asset seconds; `snapped` when pulled onto a range edge. */
	let hover = $state<{ seconds: number; snapped: boolean } | undefined>(undefined);
	/** Alt held during the last pointer event: snapping is off. */
	let snapOff = false;
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
	/** Every range edge on the timeline and the scene's edges, in asset seconds: what pointers snap to. */
	const edgeAnchors = $derived.by(() => {
		const anchors = [itemSpan.start, itemSpan.end];
		if (trimmed !== undefined) {
			anchors.push(trimmed.start, trimmed.end);
		}
		for (const track of tracks) {
			for (const range of track.ranges) {
				anchors.push(itemStart + range.start, itemStart + range.end);
			}
		}
		return anchors;
	});

	// A new item starts fitted to its span.
	$effect(() => {
		void itemSpan.start;
		void itemSpan.end;
		wheelTarget = undefined;
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

	/** Where wheel input is heading; the view eases toward it so steps of a mouse wheel glide. */
	let wheelTarget: TimelineWindow | undefined;
	let wheelFrame: number | undefined;
	let wheelClientX = 0;
	const EASE_PER_FRAME = 0.35;

	function onWheel(event: WheelEvent): void {
		event.preventDefault();
		let from = axis;
		if (wheelTarget !== undefined) {
			from = wheelTarget;
		}
		const horizontal = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
		const targetSecondsPerPixel = (from.end - from.start) / Math.max(1, laneWidth);
		if (horizontal) {
			wheelTarget = panWindow(from, bounds, wheelPixels(event, panPixels(event)) * targetSecondsPerPixel);
		} else {
			const anchor = secondsAtFraction(from, pointerFraction(event.clientX));
			wheelTarget = zoomWindow(from, bounds, anchor, Math.exp(wheelPixels(event, event.deltaY) * 0.0015));
		}
		wheelClientX = event.clientX;
		if (wheelFrame === undefined) {
			wheelFrame = requestAnimationFrame(easeTowardTarget);
		}
	}

	function easeTowardTarget(): void {
		wheelFrame = undefined;
		const target = wheelTarget;
		if (target === undefined) {
			return;
		}
		const width = target.end - target.start;
		const done = Math.abs(axis.start - target.start) < width * 0.001 && Math.abs(axis.end - target.end) < width * 0.001;
		if (done) {
			view = target;
			wheelTarget = undefined;
		} else {
			view = {
				start: axis.start + (target.start - axis.start) * EASE_PER_FRAME,
				end: axis.end + (target.end - axis.end) * EASE_PER_FRAME
			};
			wheelFrame = requestAnimationFrame(easeTowardTarget);
		}
		// The pointer stays put while the axis moves under it.
		if (hover !== undefined) {
			hover = hoverAt(wheelClientX);
		}
	}

	/** Line- and page-based wheels (Firefox) report steps, not pixels. */
	function wheelPixels(event: WheelEvent, delta: number): number {
		if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
			return delta * 16;
		}
		if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
			return delta * laneWidth;
		}
		return delta;
	}

	function pointerFraction(clientX: number): number {
		if (ruler === undefined) {
			return 0.5;
		}
		const box = ruler.getBoundingClientRect();
		return Math.min(1, Math.max(0, (clientX - box.left) / box.width));
	}

	/** Mice send Shift+wheel as vertical delta, trackpads swipe horizontally. */
	function panPixels(event: WheelEvent): number {
		if (event.shiftKey) {
			return event.deltaX + event.deltaY;
		}
		return event.deltaX;
	}

	let lastZoomId = 0;

	$effect(() => {
		const request = zoomRequest;
		if (request === undefined || request.id === lastZoomId) {
			return;
		}
		lastZoomId = request.id;
		untrack(() => zoomBy(request.factor));
	});

	function zoomBy(factor: number): void {
		wheelTarget = undefined;
		view = zoomWindow(axis, bounds, playhead, factor);
	}

	function fit(): void {
		wheelTarget = undefined;
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

	/**
	 * Snaps to frames, and to `anchor` or a range edge when close; `own` is a range whose edges are
	 * left out (the one being dragged). Edge drags pass the playhead from before they started: they
	 * seek the playhead along, and snapping to that would pin the edge in place.
	 */
	function snapped(seconds: number, anchor = playhead, own?: Range): number {
		if (snapOff) {
			return snapToAnchors(seconds, [], 0, frameRate);
		}
		return snapToAnchors(seconds, [anchor, ...anchorsWithout(own)], SNAP_PIXELS * secondsPerPixel, frameRate);
	}

	function anchorsWithout(own: Range | undefined): number[] {
		if (own === undefined) {
			return edgeAnchors;
		}
		const ownEdges = [itemStart + own.start, itemStart + own.end];
		return edgeAnchors.filter((anchor) => !ownEdges.includes(anchor));
	}

	/** The edge a hovering or scrubbing pointer is pulled onto, if one is near. */
	function edgeNear(seconds: number): number | undefined {
		if (snapOff) {
			return undefined;
		}
		return nearestAnchor(seconds, edgeAnchors, SNAP_PIXELS * secondsPerPixel);
	}

	function pointerSeconds(clientX: number): number {
		const seconds = secondsAtClientX(clientX);
		const edge = edgeNear(seconds);
		if (edge === undefined) {
			return seconds;
		}
		return edge;
	}

	function hoverAt(clientX: number): { seconds: number; snapped: boolean } {
		const seconds = secondsAtClientX(clientX);
		const edge = edgeNear(seconds);
		if (edge === undefined) {
			return { seconds, snapped: false };
		}
		return { seconds: edge, snapped: true };
	}

	function left(seconds: number): number {
		return percentAt(axis, seconds);
	}

	function widthBetween(start: number, end: number): number {
		return percentAt(axis, end) - percentAt(axis, start);
	}

	function updateHover(event: PointerEvent): void {
		snapOff = event.altKey;
		if (container === undefined || ruler === undefined) {
			return;
		}
		const box = ruler.getBoundingClientRect();
		if (event.clientX < box.left || event.clientX > box.right) {
			hover = undefined;
			return;
		}
		hover = hoverAt(event.clientX);
	}

	// The page shows the hovered frame in the player (scrubbing too); dragging a bar's edge shows
	// the real video, which seeks to that edge.
	$effect(() => {
		if (hover === undefined || (drag !== undefined && drag.kind !== 'scrub')) {
			onhover(undefined);
			return;
		}
		onhover(hover.seconds);
	});

	// --- dragging --------------------------------------------------------------------------

	function follow(onmove: (event: PointerEvent) => void, onup: (event: PointerEvent) => void): void {
		const move = (event: PointerEvent) => {
			snapOff = event.altKey;
			onmove(event);
		};
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
		snapOff = event.altKey;
		drag = { kind: 'scrub' };
		onscrub();
		onseek(pointerSeconds(event.clientX));
		follow(
			(move) => onseek(pointerSeconds(move.clientX)),
			() => undefined
		);
	}

	function startCreate(event: PointerEvent, track: LabelTrack): void {
		if (event.button !== 0 || event.target !== event.currentTarget) {
			return;
		}
		startDrawing(event, track);
	}

	/** Drawing a range (Shift: an erased part) in a track, from wherever the pointer went down. */
	function startDrawing(event: PointerEvent, track: LabelTrack): void {
		event.preventDefault();
		event.stopPropagation();
		snapOff = event.altKey;
		const target = { group: track.group.id, label: track.label.id };
		const anchor = snapped(secondsAtClientX(event.clientX));
		drag = { kind: 'create', target, anchor, current: anchor, startX: event.clientX, erase: event.shiftKey };
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
			onseek(pointerSeconds(event.clientX));
			return;
		}
		if (current.erase) {
			onerase(target, anchor, current.current);
			return;
		}
		oncreate(target, anchor, current.current);
	}

	function startEdit(event: PointerEvent, track: LabelTrack, range: Range, mode: RangeDragMode): void {
		if (event.button !== 0) {
			return;
		}
		if (event.shiftKey) {
			startDrawing(event, track);
			return;
		}
		event.preventDefault();
		snapOff = event.altKey;
		event.stopPropagation();
		const origin = secondsAtClientX(event.clientX);
		drag = { kind: 'edit', range, mode, origin, preview: range, startX: event.clientX, snapTo: playhead };
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
		const snappedPreview = snapEdges(preview, mode, drag.snapTo, range);
		drag = { ...drag, preview: snappedPreview };
		seekToEdge(snappedPreview, mode);
	}

	/**
	 * Snaps the edge being dragged; a moved bar keeps its length and snaps whichever of its edges is
	 * nearer an anchor. `own` is the bar before the drag, whose old edges are no anchors.
	 */
	function snapEdges(range: Range, mode: RangeDragMode, anchor: number, own: Range): Range {
		if (mode === 'end') {
			return draggedRange(range, 'end', snapped(itemStart + range.end, anchor, own) - itemStart - range.end, length);
		}
		if (mode === 'move') {
			return draggedRange(range, 'move', moveSnapShift(range, anchor, own), length);
		}
		return draggedRange(range, mode, snapped(itemStart + range.start, anchor, own) - itemStart - range.start, length);
	}

	function moveSnapShift(range: Range, anchor: number, own: Range): number {
		const startShift = snapped(itemStart + range.start, anchor, own) - itemStart - range.start;
		const endShift = snapped(itemStart + range.end, anchor, own) - itemStart - range.end;
		if (snapOff) {
			return startShift;
		}
		const startAnchored = isAnchored(itemStart + range.start + startShift, anchor, own);
		const endAnchored = isAnchored(itemStart + range.end + endShift, anchor, own);
		// An edge that lands on an anchor beats one that only lands on a frame.
		if (endAnchored && !startAnchored) {
			return endShift;
		}
		if (endAnchored && Math.abs(endShift) < Math.abs(startShift)) {
			return endShift;
		}
		return startShift;
	}

	function isAnchored(seconds: number, anchor: number, own: Range): boolean {
		return [anchor, ...anchorsWithout(own)].some((candidate) => Math.abs(candidate - seconds) < 1e-9);
	}

	let pendingSeek: number | undefined;

	// Shows the frame under the edge being dragged, so it can be placed exactly; one seek per
	// animation frame, however fast the pointer moves.
	function seekToEdge(range: Range, mode: RangeDragMode): void {
		const wasQueued = pendingSeek !== undefined;
		pendingSeek = itemStart + range.start;
		if (mode === 'end') {
			pendingSeek = itemStart + range.end;
		}
		if (wasQueued) {
			return;
		}
		requestAnimationFrame(() => {
			if (pendingSeek !== undefined) {
				onseek(pendingSeek);
			}
			pendingSeek = undefined;
		});
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

	/** Share of the lane before / after the current scene (or its trim), 0 when none is in view. */
	const outsideBefore = $derived(Math.min(1, Math.max(0, left(wholeSpan().start) / 100)));
	const outsideAfter = $derived(Math.min(1, Math.max(0, 1 - left(wholeSpan().end) / 100)));

	function isDragging(range: Range): boolean {
		return drag !== undefined && drag.kind === 'edit' && drag.range === range;
	}

	function shownRange(range: Range): Range {
		if (drag !== undefined && drag.kind === 'edit' && drag.range === range) {
			return drag.preview;
		}
		return range;
	}

	function creatingIn(track: LabelTrack): { start: number; end: number; erase: boolean } | undefined {
		if (drag === undefined || drag.kind !== 'create') {
			return undefined;
		}
		if (drag.target.group !== track.group.id || drag.target.label !== track.label.id) {
			return undefined;
		}
		return { start: Math.min(drag.anchor, drag.current), end: Math.max(drag.anchor, drag.current), erase: drag.erase };
	}

	function pendingIn(track: LabelTrack): { start: number; end: number } | undefined {
		const open = pending.find((candidate) => candidate.group === track.group.id && candidate.label === track.label.id);
		if (open === undefined) {
			return undefined;
		}
		const start = itemStart + open.start;
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
			return `${track.group.label}: ${track.label.name}, for the entire scene. Drag inside the track to mark only the parts where it happens, Shift+drag to cut a part out.`;
		}
		return `${track.group.label}: ${track.label.name}. Drag in the track to add a range, Shift+drag to erase one.`;
	}
</script>

<div
	bind:this={container}
	class="relative flex flex-col gap-1.5 select-none"
	style="--gutter: 11rem; --lane-left: calc(var(--gutter) + 0.5rem); --lane-width: calc(100% - var(--gutter) - 0.5rem)"
	onpointermove={updateHover}
	onpointerleave={() => (hover = undefined)}
	role="group"
	aria-label="Timeline"
>

	<!-- ruler and tracks share one box, so the dimming outside the scene covers both -->
	<div class="relative flex flex-col gap-1.5">
		<!-- ruler: filmstrip, item span, trim, ticks -->
		<div class="grid grid-cols-[var(--gutter)_1fr] items-stretch gap-2">
			<div class="text-dim flex flex-col justify-center text-right font-mono text-sm leading-snug tabular-nums">
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
				class="border-line bg-surface relative h-[6.25rem] cursor-col-resize overflow-hidden rounded-md border"
			>
				{#if media?.filmstrip}
					<div class="pointer-events-none absolute inset-x-0 top-0 h-20 opacity-90">
						<media.filmstrip {asset} start={axis.start} end={axis.end} count={filmstripCount} />
					</div>
				{/if}
				<div class="border-blue pointer-events-none absolute inset-y-0 z-10 border-x-2" style="left: {left(itemSpan.start)}%; width: {widthBetween(itemSpan.start, itemSpan.end)}%" title="Item span">
					<div class="bg-blue h-1 w-full"></div>
				</div>
				{#if trimmed}
					<div class="border-amber pointer-events-none absolute top-1 h-18 border-x-2 border-dashed" style="left: {left(trimmed.start)}%; width: {widthBetween(trimmed.start, trimmed.end)}%" title="Trimmed span"></div>
				{/if}
				<div class="pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-black/40">
					{#each ticks as tick (tick)}
						<div class="absolute bottom-0 h-full border-l border-white/20" style="left: {left(tick)}%">
							<span class="text-dim absolute bottom-0.5 left-1 font-mono text-xs whitespace-nowrap">{formatClock(tick, tickDecimals)}</span>
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
					class="flex min-w-0 items-center justify-end gap-1.5 text-right text-sm leading-tight {track.armed ? 'text-default' : 'text-dim hover:text-muted'}"
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
					class="bg-surface relative cursor-crosshair rounded {track.refines ? 'h-7' : 'h-9'} {track.armed ? 'ring-violet/50 ring-1' : ''}"
					title={trackTitle(track)}
				>
					{#if track.whole}
						<div class="bg-violet/25 border-violet/50 pointer-events-none absolute inset-y-0.5 flex items-center rounded-sm border border-dashed gap-1 overflow-hidden px-1.5 text-sm whitespace-nowrap text-white" style="left: {left(wholeSpan().start)}%; width: {widthBetween(wholeSpan().start, wholeSpan().end)}%">
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
							class="border-violet text-violet hover:bg-violet/20 absolute inset-y-0.5 overflow-hidden rounded-sm border border-dashed px-1 text-left text-2xs leading-4 whitespace-nowrap"
							style="left: {left(itemStart + ghost.start)}%; width: {widthBetween(itemStart + ghost.start, itemStart + ghost.end)}%"
						>
							{Math.round(ghost.score * 100)} %
						</button>
					{/each}

					{#each track.ranges as range, index (range)}
						{@const shown = shownRange(range)}
						{@const note = track.rangeNotes[index]}
						{@const active = range === selected || isDragging(range)}
						<div
							role="button"
							tabindex="-1"
							title="{describe(shown)}. Drag to move, edges to resize, Shift+drag to erase a part, double-click to loop it."
							onpointerdown={(event) => startEdit(event, track, range, 'move')}
							ondblclick={() => onloop(range)}
							class="group/bar absolute inset-y-0 cursor-grab rounded-sm {barClass(range)}"
							style="left: {left(itemStart + shown.start)}%; width: {widthBetween(itemStart + shown.start, itemStart + shown.end)}%"
						>
							<span class="pointer-events-none flex h-full items-center gap-1 overflow-hidden px-2 text-sm whitespace-nowrap text-white">
								<span class="font-medium">{track.label.name}</span>
								{#if note}<span class="text-white/80">· {note}</span>{/if}
								<span class="opacity-60">{formatClock(shown.end - shown.start, 1)}</span>
							</span>
							<!-- Edge handles reach a few pixels past the bar, so short bars stay resizable. -->
							<div role="presentation" class="absolute inset-y-0 -left-1.5 z-10 flex w-3 cursor-ew-resize justify-center" onpointerdown={(event) => startEdit(event, track, range, 'start')}>
								<span class="my-1 w-1 rounded-full {active ? 'bg-white' : 'bg-white/0 group-hover/bar:bg-white/60'}"></span>
							</div>
							<div role="presentation" class="absolute inset-y-0 -right-1.5 z-10 flex w-3 cursor-ew-resize justify-center" onpointerdown={(event) => startEdit(event, track, range, 'end')}>
								<span class="my-1 w-1 rounded-full {active ? 'bg-white' : 'bg-white/0 group-hover/bar:bg-white/60'}"></span>
							</div>
							{#if active}
								<span class="edge-time right-full mr-1.5">{formatClock(itemStart + shown.start, 2)}</span>
								<span class="edge-time left-full ml-1.5">{formatClock(itemStart + shown.end, 2)}</span>
							{/if}
						</div>
					{/each}

					{#if creating && creating.erase}
						<div class="erasing border-red pointer-events-none absolute inset-y-0 z-20 rounded-sm border" style="left: {left(creating.start)}%; width: {widthBetween(creating.start, creating.end)}%"></div>
					{:else if creating}
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
				<span class="text-faint border-line rounded border border-dashed px-2 py-1 text-xs">Pick a label on the right: its track shows up here, and dragging in it limits the label to a range.</span>
			</div>
		{/if}

		<!-- everything outside the current scene (or its trim), grayed out across ruler and tracks -->
		{#if outsideBefore > 0}
			<div class="outside" style="left: var(--lane-left); width: calc(var(--lane-width) * {outsideBefore})"></div>
		{/if}
		{#if outsideAfter > 0}
			<div class="outside" style="right: 0; width: calc(var(--lane-width) * {outsideAfter})"></div>
		{/if}

		<!-- playhead and hover line across ruler and tracks -->
		<div class="pointer-events-none absolute inset-y-0 z-20 w-px bg-white" style="left: calc(var(--lane-left) + var(--lane-width) * {left(playhead) / 100})"></div>
		{#if hover}
			<div
				class="pointer-events-none absolute inset-y-0 z-20 {hover.snapped ? 'bg-violet w-0.5' : 'w-px bg-white/30'}"
				style="left: calc(var(--lane-left) + var(--lane-width) * {left(hover.seconds) / 100})"
				title={hover.snapped ? 'On a range edge' : undefined}
			></div>
		{/if}
	</div>

	<div class="text-faint flex items-center gap-2 text-xs">
		{#if selected}
			<div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
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
			<span class="min-w-0 flex-1 truncate"><span class="font-mono">/</span> start a label at the playhead · <span class="font-mono">]</span> end it · <span class="font-mono">S</span> pick suggestions from here · drag in a track or a bar's edges (Shift: erase) · <span class="font-mono">Ctrl+Z</span> undo · <span class="font-mono">?</span> all keys</span>
		{/if}
		<div class="flex shrink-0 gap-0.5">
			<button type="button" tabindex="-1" class="btn btn-ghost btn-xs btn-square" onmousedown={(event) => event.preventDefault()} onclick={() => zoomBy(settings.value.zoomStep)} title="Zoom out (wheel, -)"><MagnifyingGlassMinusIcon size={14} /></button>
			<button type="button" tabindex="-1" class="btn btn-ghost btn-xs btn-square" onmousedown={(event) => event.preventDefault()} onclick={() => zoomBy(1 / settings.value.zoomStep)} title="Zoom in around the playhead (wheel, +)"><MagnifyingGlassPlusIcon size={14} /></button>
			<button type="button" tabindex="-1" class="btn btn-ghost btn-xs btn-square" disabled={!zoomed} onmousedown={(event) => event.preventDefault()} onclick={fit} title="Fit the item"><ArrowsOutLineHorizontalIcon size={14} /></button>
		</div>
	</div>
</div>

<style>
	.outside {
		pointer-events: none;
		position: absolute;
		top: 0;
		bottom: 0;
		z-index: 15;
		background: color-mix(in srgb, var(--bg) 72%, transparent);
		backdrop-filter: grayscale(1);
	}

	.erasing {
		background: repeating-linear-gradient(-45deg, rgb(248 113 113 / 0.35) 0 4px, rgb(0 0 0 / 0.35) 4px 8px);
	}

	.edge-time {
		pointer-events: none;
		position: absolute;
		top: 50%;
		z-index: 30;
		transform: translateY(-50%);
		border-radius: 0.25rem;
		background: rgb(0 0 0 / 0.8);
		padding: 0.0625rem 0.25rem;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: calc(11px * var(--text-scale));
		font-variant-numeric: tabular-nums;
		color: white;
		white-space: nowrap;
	}
</style>
