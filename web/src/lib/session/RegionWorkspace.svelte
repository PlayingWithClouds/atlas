<script lang="ts">
	import { onMount } from 'svelte';
	import { getNext, imageUrl, postAnnotations, postSkip, deleteImage } from '$lib/api/label';
	import { veilImg } from '$lib/api/client';
	import { classes as classesStore } from '$lib/stores/classes';
	import { metaFor } from '$lib/labels';
	import type { Annotation } from '$lib/primitives';
	import CursorIcon from 'phosphor-svelte/lib/Cursor';
	import RectangleIcon from 'phosphor-svelte/lib/Rectangle';
	import PolygonIcon from 'phosphor-svelte/lib/Polygon';
	import MapPinIcon from 'phosphor-svelte/lib/MapPin';
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwise';

	let { sid, token = 0 }: { sid: string; token?: number } = $props();

	type Tool = 'select' | 'rect' | 'polygon' | 'keypoint';
	type Region = {
		id: string;
		type: 'rect' | 'polygon' | 'keypoint';
		x?: number; y?: number; w?: number; h?: number;
		points?: [number, number][];
		labels: string[];
	};

	let imageId = $state<number | null>(null);
	let done = $state(false);
	let waiting = $state(false);
	let src = $state('');
	let regions = $state<Region[]>([]);
	let tool = $state<Tool>('rect');
	let selectedId = $state<string | null>(null);
	let saving = $state(false);

	// viewport transform (percent-space <g>)
	let scale = $state(1);
	let tx = $state(0);
	let ty = $state(0);

	let svgEl = $state<SVGSVGElement | null>(null);
	let gEl = $state<SVGGElement | null>(null);

	// in-progress geometry
	let draftRect = $state<{ x: number; y: number; w: number; h: number } | null>(null);
	let draftPoly = $state<[number, number][]>([]);
	let dragStart: { x: number; y: number } | null = null;
	let movingRegion: Region | null = null;

	const classList = $derived($classesStore);
	const selected = $derived(regions.find((r) => r.id === selectedId) ?? null);

	let uid = 0;
	function nid() {
		uid += 1;
		return `r${uid}`;
	}

	function color(labels: string[]): string {
		const name = labels[0];
		if (!name) return 'oklch(70% 0.02 250)';
		const group = metaFor(name).group;
		let h = 0;
		for (const c of group) h = (h * 31 + c.charCodeAt(0)) % 360;
		return `oklch(68% 0.16 ${h})`;
	}

	// --- data ---------------------------------------------------------------
	function toRegions(anns: Annotation[]): Region[] {
		return anns
			.filter((a) => a.type !== 'tag')
			.map((a) => {
				const v = a.value as Record<string, unknown>;
				const labels = (v.labels as string[]) ?? [];
				if (a.type === 'rect') return { id: nid(), type: 'rect' as const, x: v.x as number, y: v.y as number, w: v.w as number, h: v.h as number, labels };
				if (a.type === 'polygon') return { id: nid(), type: 'polygon' as const, points: v.points as [number, number][], labels };
				return { id: nid(), type: 'keypoint' as const, x: v.x as number, y: v.y as number, labels };
			});
	}
	function toAnnotations(): Annotation[] {
		return regions.map((r) => {
			if (r.type === 'rect') return { type: 'rect', value: { x: r.x, y: r.y, w: r.w, h: r.h, rotation: 0, labels: r.labels } };
			if (r.type === 'polygon') return { type: 'polygon', value: { points: r.points, labels: r.labels } };
			return { type: 'keypoint', value: { x: r.x, y: r.y, labels: r.labels } };
		});
	}

	async function load() {
		const next = await getNext(sid);
		done = !!next.done;
		waiting = !!next.waiting;
		if (next.done || next.waiting || next.id == null) {
			imageId = null;
			return;
		}
		imageId = next.id;
		regions = toRegions(next.annotations ?? []);
		selectedId = null;
		resetView();
		const url = imageUrl(sid, next.id, token);
		src = url;
	}

	onMount(load);

	// --- coords -------------------------------------------------------------
	function toLocal(evt: PointerEvent | WheelEvent): { x: number; y: number } {
		if (!svgEl || !gEl) return { x: 0, y: 0 };
		const pt = svgEl.createSVGPoint();
		pt.x = evt.clientX;
		pt.y = evt.clientY;
		const ctm = gEl.getScreenCTM();
		if (!ctm) return { x: 0, y: 0 };
		const p = pt.matrixTransform(ctm.inverse());
		return { x: p.x, y: p.y };
	}

	function resetView() {
		scale = 1;
		tx = 0;
		ty = 0;
	}

	function onWheel(evt: WheelEvent) {
		evt.preventDefault();
		const p = toLocal(evt);
		const factor = evt.deltaY < 0 ? 1.12 : 1 / 1.12;
		const ns = Math.max(1, Math.min(8, scale * factor));
		// keep cursor point stable
		tx = p.x - (p.x - tx) * (ns / scale);
		ty = p.y - (p.y - ty) * (ns / scale);
		scale = ns;
	}

	// --- pointer interaction ------------------------------------------------
	function onPointerDown(evt: PointerEvent) {
		if (imageId == null) return;
		(evt.target as Element).setPointerCapture?.(evt.pointerId);
		const p = toLocal(evt);

		if (evt.button === 1 || evt.shiftKey) {
			dragStart = { x: evt.clientX, y: evt.clientY };
			movingRegion = null;
			return; // pan
		}
		if (tool === 'rect') {
			draftRect = { x: p.x, y: p.y, w: 0, h: 0 };
		} else if (tool === 'keypoint') {
			commit({ id: nid(), type: 'keypoint', x: p.x, y: p.y, labels: [] });
		} else if (tool === 'polygon') {
			draftPoly = [...draftPoly, [p.x, p.y]];
		} else if (tool === 'select') {
			const hit = hitTest(p);
			selectedId = hit?.id ?? null;
			if (hit) {
				movingRegion = hit;
				dragStart = { x: p.x, y: p.y };
			}
		}
	}

	function onPointerMove(evt: PointerEvent) {
		const p = toLocal(evt);
		if (draftRect) {
			draftRect = { x: draftRect.x, y: draftRect.y, w: p.x - draftRect.x, h: p.y - draftRect.y };
			return;
		}
		if (movingRegion && dragStart) {
			const dx = p.x - dragStart.x;
			const dy = p.y - dragStart.y;
			dragStart = { x: p.x, y: p.y };
			moveRegion(movingRegion, dx, dy);
			return;
		}
		if (dragStart && !movingRegion) {
			// pan (client-space delta → local)
			const k = 100 / (svgEl?.getBoundingClientRect().width ?? 100) / scale;
			tx += (evt.movementX ?? 0) * k * scale;
			ty += (evt.movementY ?? 0) * k * scale;
		}
	}

	function onPointerUp() {
		if (draftRect) {
			const r = normRect(draftRect);
			if (r.w > 0.5 && r.h > 0.5) commit({ id: nid(), type: 'rect', ...r, labels: [] });
			draftRect = null;
		}
		dragStart = null;
		movingRegion = null;
	}

	function normRect(d: { x: number; y: number; w: number; h: number }) {
		return { x: Math.min(d.x, d.x + d.w), y: Math.min(d.y, d.y + d.h), w: Math.abs(d.w), h: Math.abs(d.h) };
	}

	function closePolygon() {
		if (draftPoly.length >= 3) commit({ id: nid(), type: 'polygon', points: draftPoly, labels: [] });
		draftPoly = [];
	}

	function commit(r: Region) {
		regions = [...regions, r];
		selectedId = r.id;
		tool = 'select';
	}

	function moveRegion(r: Region, dx: number, dy: number) {
		regions = regions.map((x) => {
			if (x.id !== r.id) return x;
			if (x.type === 'polygon') return { ...x, points: x.points!.map(([px, py]) => [px + dx, py + dy] as [number, number]) };
			return { ...x, x: (x.x ?? 0) + dx, y: (x.y ?? 0) + dy };
		});
	}

	function hitTest(p: { x: number; y: number }): Region | null {
		for (let i = regions.length - 1; i >= 0; i--) {
			const r = regions[i];
			if (r.type === 'rect' && p.x >= r.x! && p.x <= r.x! + r.w! && p.y >= r.y! && p.y <= r.y! + r.h!) return r;
			if (r.type === 'keypoint' && Math.hypot(p.x - r.x!, p.y - r.y!) < 2.5) return r;
			if (r.type === 'polygon' && pointInPoly(p, r.points!)) return r;
		}
		return null;
	}
	function pointInPoly(p: { x: number; y: number }, poly: [number, number][]): boolean {
		let inside = false;
		for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
			const [xi, yi] = poly[i];
			const [xj, yj] = poly[j];
			if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
		}
		return inside;
	}

	function assign(name: string) {
		if (!selected) return;
		regions = regions.map((r) => (r.id === selected.id ? { ...r, labels: [name] } : r));
	}
	function removeSelected() {
		if (!selectedId) return;
		regions = regions.filter((r) => r.id !== selectedId);
		selectedId = null;
	}

	async function saveNext() {
		if (imageId == null) return;
		saving = true;
		try {
			await postAnnotations(sid, imageId, toAnnotations());
			await load();
		} finally {
			saving = false;
		}
	}
	async function skip() {
		if (imageId == null) return;
		await postSkip(sid, imageId);
		await load();
	}
	// Delete removes the image from the session entirely (unlike skip).
	async function deleteCurrentImage() {
		if (imageId == null) return;
		await deleteImage(sid, imageId);
		await load();
	}

	function onKey(evt: KeyboardEvent) {
		if ((evt.target as HTMLElement)?.tagName === 'INPUT') return;
		const k = evt.key.toLowerCase();
		if (k === 'v') tool = 'select';
		else if (k === 'r') tool = 'rect';
		else if (k === 'p') tool = 'polygon';
		else if (k === 'k') tool = 'keypoint';
		else if (k === 'delete' || k === 'backspace') { evt.preventDefault(); removeSelected(); }
		else if (k === 'd' && evt.shiftKey) { evt.preventDefault(); deleteCurrentImage(); }
		else if (k === 'enter') { evt.preventDefault(); if (draftPoly.length) closePolygon(); else saveNext(); }
		else if (k === 'escape') { draftPoly = []; selectedId = null; }
		else if (k === '0') resetView();
		else if (evt.key >= '1' && evt.key <= '9') {
			const cls = classList[Number(evt.key) - 1];
			if (cls && selected) assign(cls);
		}
	}

	const tools: [Tool, typeof CursorIcon, string][] = [
		['select', CursorIcon, 'V'],
		['rect', RectangleIcon, 'R'],
		['polygon', PolygonIcon, 'P'],
		['keypoint', MapPinIcon, 'K']
	];
</script>

<svelte:window onkeydown={onKey} />

<div class="flex h-full">
	<!-- toolbar -->
	<div class="border-line bg-base-200 flex w-12 shrink-0 flex-col items-center gap-1 border-r py-3">
		{#each tools as [t, Icon, key] (t)}
			<button type="button" onclick={() => (tool = t)} title="{t} ({key})"
				class="flex h-9 w-9 items-center justify-center rounded-md {tool === t ? 'bg-primary text-primary-content' : 'text-dim hover:bg-hover hover:text-default'}">
				<Icon size={17} />
			</button>
		{/each}
		<div class="bg-line my-1 h-px w-6"></div>
		<button type="button" onclick={removeSelected} disabled={!selectedId} title="Delete (Del)" class="text-dim hover:bg-hover hover:text-red flex h-9 w-9 items-center justify-center rounded-md disabled:opacity-30"><TrashIcon size={16} /></button>
		<button type="button" onclick={resetView} title="Fit (0)" class="text-dim hover:bg-hover hover:text-default flex h-9 w-9 items-center justify-center rounded-md"><ArrowClockwiseIcon size={15} /></button>
	</div>

	<!-- canvas -->
	<div class="bg-base-100 relative min-w-0 flex-1">
		{#if done}
			<div class="text-dim flex h-full items-center justify-center text-sm">🎉 Nothing left to annotate.</div>
		{:else if waiting}
			<div class="text-dim flex h-full items-center justify-center gap-2 text-sm"><span class="loading"></span> Waiting for images…</div>
		{:else if imageId != null}
			<svg bind:this={svgEl} viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" class="h-full w-full touch-none select-none"
				onwheel={onWheel} onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp} role="application" aria-label="annotation canvas">
				<g bind:this={gEl} transform="translate({tx} {ty}) scale({scale})">
					<image href={src.startsWith('http') ? veilImg(src) : src} x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMid meet" />
					{#each regions as r (r.id)}
						{@const c = color(r.labels)}
						{@const sel = r.id === selectedId}
						{#if r.type === 'rect'}
							<rect x={r.x} y={r.y} width={r.w} height={r.h} fill={c} fill-opacity={sel ? 0.25 : 0.12} stroke={c} stroke-width={sel ? 0.6 : 0.4} vector-effect="non-scaling-stroke" />
						{:else if r.type === 'polygon'}
							<polygon points={r.points!.map((p) => p.join(',')).join(' ')} fill={c} fill-opacity={sel ? 0.25 : 0.12} stroke={c} stroke-width={sel ? 0.6 : 0.4} vector-effect="non-scaling-stroke" />
						{:else}
							<circle cx={r.x} cy={r.y} r="1.2" fill={c} stroke="white" stroke-width="0.3" vector-effect="non-scaling-stroke" />
						{/if}
					{/each}
					{#if draftRect}
						{@const r = normRect(draftRect)}
						<rect x={r.x} y={r.y} width={r.w} height={r.h} fill="none" stroke="white" stroke-width="0.4" stroke-dasharray="1 1" vector-effect="non-scaling-stroke" />
					{/if}
					{#if draftPoly.length}
						<polyline points={draftPoly.map((p) => p.join(',')).join(' ')} fill="none" stroke="white" stroke-width="0.4" vector-effect="non-scaling-stroke" />
						{#each draftPoly as pt (pt.join())}<circle cx={pt[0]} cy={pt[1]} r="0.7" fill="white" />{/each}
					{/if}
				</g>
			</svg>
			{#if tool === 'polygon' && draftPoly.length >= 3}
				<button type="button" onclick={closePolygon} class="btn btn-xs btn-primary absolute bottom-3 left-1/2 -translate-x-1/2">Close polygon (Enter)</button>
			{/if}
		{/if}
	</div>

	<!-- right panel: regions + labels -->
	<div class="border-line bg-elevated flex w-64 shrink-0 flex-col border-l">
		<div class="border-line flex items-center gap-2 border-b p-3">
			<span class="text-dim flex-1 text-xs">{regions.length} region{regions.length === 1 ? '' : 's'}</span>
			<button type="button" class="btn btn-xs btn-ghost" onclick={skip} disabled={imageId == null}>Skip</button>
			<button type="button" class="btn btn-xs btn-ghost text-error" onclick={deleteCurrentImage} disabled={imageId == null} title="Delete image (⇧D)">Delete</button>
			<button type="button" class="btn btn-xs btn-primary" onclick={saveNext} disabled={imageId == null || saving}>
				{#if saving}<span class="loading loading-xs"></span>{:else}Save ↵{/if}
			</button>
		</div>

		<div class="min-h-0 flex-1 overflow-y-auto">
			{#each regions as r (r.id)}
				<button type="button" onclick={() => (selectedId = r.id)}
					class="border-line flex w-full items-center gap-2 border-b px-3 py-2 text-left text-xs {r.id === selectedId ? 'bg-hover' : 'hover:bg-hover/50'}">
					<span class="inline-block h-3 w-3 rounded-sm" style="background:{color(r.labels)}"></span>
					<span class="text-default flex-1 truncate">{r.labels[0] ?? '(unlabeled)'}</span>
					<span class="text-faint">{r.type}</span>
				</button>
			{:else}
				<div class="text-dim p-4 text-center text-xs">Draw a region on the image.</div>
			{/each}
		</div>

		{#if selected}
			<div class="border-line border-t p-2">
				<div class="text-faint mb-1 px-1 text-[10px] font-semibold tracking-wider uppercase">Label (1–9)</div>
				<div class="flex flex-wrap gap-1">
					{#each classList as name, i (name)}
						<button type="button" onclick={() => assign(name)}
							class="rounded px-2 py-1 text-xs {selected.labels[0] === name ? 'bg-primary text-primary-content' : 'bg-surface text-muted hover:bg-hover'}">
							{#if i < 9}<span class="text-faint mr-1 font-mono text-[10px]">{i + 1}</span>{/if}{name}
						</button>
					{/each}
				</div>
			</div>
		{/if}
	</div>
</div>
