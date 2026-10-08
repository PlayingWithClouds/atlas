<script lang="ts">
	import type { Item, Project, Session } from '@atlas/contracts';
	import type { AnnotationToolContribution } from '@atlas/contracts/web';
	import { EmptyState } from '@atlas/web/components';
	import { kernelContext } from '@atlas/web/kernel';
	import { onMount } from 'svelte';
	import CursorIcon from 'phosphor-svelte/lib/Cursor';
	import MapPinIcon from 'phosphor-svelte/lib/MapPin';
	import PolygonIcon from 'phosphor-svelte/lib/Polygon';
	import RectangleIcon from 'phosphor-svelte/lib/Rectangle';
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwise';
	import RegionCanvas from './RegionCanvas.svelte';
	import {
		fromAnnotation,
		hueOf,
		isRegionAnnotation,
		moveRegion,
		regionFromDraft,
		toAnnotation,
		unlabeledRegions
	} from './regionGeometry';
	import type { Region, RegionDraft } from './regionGeometry';

	let { project, session }: { project: Project; session: Session } = $props();

	const ctx = kernelContext();
	const SELECT_TOOL = 'select';
	const toolIcons: Record<string, typeof CursorIcon> = {
		select: CursorIcon,
		rect: RectangleIcon,
		polygon: PolygonIcon,
		keypoint: MapPinIcon
	};

	let item = $state<Item | null>(null);
	let finished = $state(false);
	let waiting = $state(false);
	let regions = $state<Region[]>([]);
	let tool = $state(SELECT_TOOL);
	let selectedId = $state('');
	let saving = $state(false);
	let error = $state('');
	let nextRegionNumber = 0;
	let canvas = $state<ReturnType<typeof RegionCanvas> | null>(null);

	const classNames = $derived(
		project.config.labels.groups.flatMap((group) => group.classes.map((labelClass) => labelClass.name))
	);
	const tools = $derived(
		ctx.annotationTools.list().filter((candidate) => project.config.primitives.includes(candidate.primitive))
	);
	const activeTool = $derived(tools.find((candidate) => candidate.primitive === tool));
	const selectedRegion = $derived(regions.find((region) => region.id === selectedId));

	onMount(() => {
		void load();
	});

	function newRegionId(): string {
		nextRegionNumber += 1;
		return `region-${nextRegionNumber}`;
	}

	function failWith(failure: unknown) {
		error = failure instanceof Error ? failure.message : String(failure);
	}

	async function load() {
		error = '';
		try {
			const next = await ctx.api.get<{ item?: Item; done: boolean; waiting: boolean }>(`/sessions/${session.id}/next`);
			finished = next.done;
			waiting = next.waiting;
			item = next.item === undefined ? null : next.item;
			regions = regionsOf(item);
			selectedId = '';
		} catch (failure) {
			failWith(failure);
		}
	}

	function regionsOf(current: Item | null): Region[] {
		if (current === null) return [];
		const found: Region[] = [];
		for (const annotation of current.annotations) {
			const region = fromAnnotation(annotation, newRegionId());
			if (region) found.push(region);
		}
		return found;
	}

	function colorOf(label: string): string {
		if (label === '') return 'oklch(70% 0.02 250)';
		return `oklch(68% 0.16 ${hueOf(label)})`;
	}

	function createRegion(draft: RegionDraft) {
		const region = regionFromDraft(draft, newRegionId());
		regions = [...regions, region];
		selectedId = region.id;
		tool = SELECT_TOOL;
	}

	function shiftRegion(regionId: string, shiftX: number, shiftY: number) {
		regions = regions.map((region) => (region.id === regionId ? moveRegion(region, shiftX, shiftY) : region));
	}

	function assignLabel(name: string) {
		if (!selectedRegion) return;
		regions = regions.map((region) => (region.id === selectedRegion.id ? { ...region, label: name } : region));
	}

	function removeSelected() {
		if (selectedId === '') return;
		regions = regions.filter((region) => region.id !== selectedId);
		selectedId = '';
	}

	async function guarded(task: () => Promise<void>) {
		if (saving || !item) return;
		saving = true;
		error = '';
		try {
			await task();
			await load();
		} catch (failure) {
			failWith(failure);
		} finally {
			saving = false;
		}
	}

	function annotationsToSave() {
		const kept = item ? item.annotations.filter((annotation) => !isRegionAnnotation(annotation)) : [];
		return [...kept, ...regions.map(toAnnotation)];
	}

	function saveAndNext() {
		const missing = unlabeledRegions(regions);
		if (missing.length > 0) {
			selectedId = missing[0].id;
			error = `${missing.length} region(s) still need a class.`;
			return;
		}
		return guarded(async () => {
			await ctx.api.post(`/items/${item!.id}/label`, { annotations: annotationsToSave() });
		});
	}

	function skip() {
		return guarded(async () => {
			await ctx.api.post(`/items/${item!.id}/skip`);
		});
	}

	function deleteItem() {
		return guarded(async () => {
			await ctx.api.delete(`/items/${item!.id}`);
		});
	}

	function toolForHotkey(key: string): AnnotationToolContribution | undefined {
		return tools.find((candidate) => candidate.hotkey !== undefined && candidate.hotkey.toLowerCase() === key.toLowerCase());
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		if (event.key === 'v') tool = SELECT_TOOL;
		else if (event.key === 'Delete' || event.key === 'Backspace') {
			event.preventDefault();
			removeSelected();
		} else if (event.key === 'D' && event.shiftKey) {
			event.preventDefault();
			void deleteItem();
		} else if (event.key === 'Enter') {
			event.preventDefault();
			if (canvas?.hasPolygonDraft()) canvas.closePolygon();
			else void saveAndNext();
		} else if (event.key === 'Escape') {
			canvas?.cancelDraft();
			selectedId = '';
		} else if (event.key === '0') resetView();
		else if (event.key >= '1' && event.key <= '9') {
			const name = classNames[Number(event.key) - 1];
			if (name) assignLabel(name);
		} else {
			const drawing = toolForHotkey(event.key);
			if (drawing) tool = drawing.primitive;
		}
	}

	let resetCounter = $state(0);
	function resetView() {
		resetCounter += 1;
	}

	const resetSignal = $derived(`${item ? item.id : ''}:${resetCounter}`);
	const mediaSource = $derived(item ? ctx.api.url(`/items/${item.id}/media`) : '');
</script>

<svelte:window onkeydown={onKeydown} />

<div class="flex h-full">
	<div class="border-line bg-base-200 flex w-12 shrink-0 flex-col items-center gap-1 border-r py-3">
		<button
			type="button"
			onclick={() => (tool = SELECT_TOOL)}
			title="Select (V)"
			class="flex h-9 w-9 items-center justify-center rounded-md {tool === SELECT_TOOL ? 'bg-primary text-primary-content' : 'text-dim hover:bg-hover hover:text-default'}"
		>
			<CursorIcon size={17} />
		</button>
		{#each tools as drawing (drawing.id)}
			{@const Icon = toolIcons[drawing.primitive]}
			<button
				type="button"
				onclick={() => (tool = drawing.primitive)}
				title={drawing.hotkey ? `${drawing.label} (${drawing.hotkey})` : drawing.label}
				class="flex h-9 w-9 items-center justify-center rounded-md {tool === drawing.primitive ? 'bg-primary text-primary-content' : 'text-dim hover:bg-hover hover:text-default'}"
			>
				{#if Icon}<Icon size={17} />{:else}{drawing.label.slice(0, 1)}{/if}
			</button>
		{/each}
		<div class="bg-line my-1 h-px w-6"></div>
		<button type="button" onclick={removeSelected} disabled={selectedId === ''} title="Delete region (Del)" class="text-dim hover:bg-hover hover:text-red flex h-9 w-9 items-center justify-center rounded-md disabled:opacity-30">
			<TrashIcon size={16} />
		</button>
		<button type="button" onclick={resetView} title="Fit (0)" class="text-dim hover:bg-hover hover:text-default flex h-9 w-9 items-center justify-center rounded-md">
			<ArrowClockwiseIcon size={15} />
		</button>
	</div>

	<div class="bg-base-100 relative min-w-0 flex-1">
		{#if error}<div class="alert alert-error absolute top-3 left-3 z-10 text-sm">{error}</div>{/if}
		{#if finished}
			<div class="p-6"><EmptyState title="Nothing left to annotate" hint="Every item in this session is labeled or skipped." /></div>
		{:else if waiting}
			<div class="text-dim flex h-full items-center justify-center gap-2 text-sm"><span class="loading"></span> Waiting for items…</div>
		{:else if item}
			<RegionCanvas
				bind:this={canvas}
				src={mediaSource}
				{regions}
				{tool}
				{selectedId}
				{resetSignal}
				onCreate={createRegion}
				onSelect={(regionId) => (selectedId = regionId)}
				onMove={shiftRegion}
				onToolReset={() => (tool = SELECT_TOOL)}
			/>
			{#if tool === 'polygon' && canvas?.hasPolygonDraft()}
				<button type="button" onclick={() => canvas?.closePolygon()} class="btn btn-xs btn-primary absolute bottom-3 left-1/2 -translate-x-1/2">Close polygon (Enter)</button>
			{/if}
		{:else}
			<div class="text-dim flex h-full items-center justify-center"><span class="loading"></span></div>
		{/if}
	</div>

	<div class="border-line bg-elevated flex w-64 shrink-0 flex-col border-l">
		<div class="border-line flex items-center gap-2 border-b p-3">
			<span class="text-dim flex-1 text-xs">{regions.length} region{regions.length === 1 ? '' : 's'}</span>
			<button type="button" class="btn btn-xs btn-ghost" onclick={skip} disabled={!item || saving}>Skip</button>
			<button type="button" class="btn btn-xs btn-ghost text-error" onclick={deleteItem} disabled={!item || saving} title="Delete item (⇧D)">Delete</button>
			<button type="button" class="btn btn-xs btn-primary" onclick={saveAndNext} disabled={!item || saving}>
				{#if saving}<span class="loading loading-xs"></span>{:else}Save ↵{/if}
			</button>
		</div>

		{#if activeTool && item}
			<div class="pt-2"><activeTool.component {project} {item} /></div>
		{/if}

		<div class="min-h-0 flex-1 overflow-y-auto">
			{#each regions as region (region.id)}
				<button
					type="button"
					onclick={() => (selectedId = region.id)}
					class="border-line flex w-full items-center gap-2 border-b px-3 py-2 text-left text-xs {region.id === selectedId ? 'bg-hover' : 'hover:bg-hover/50'}"
				>
					<span class="inline-block h-3 w-3 rounded-sm" style="background:{colorOf(region.label)}"></span>
					<span class="text-default flex-1 truncate">{region.label === '' ? '(unlabeled)' : region.label}</span>
					<span class="text-faint">{region.type}</span>
				</button>
			{:else}
				<div class="text-dim p-4 text-center text-xs">Pick a tool and draw on the image.</div>
			{/each}
		</div>

		{#if selectedRegion}
			<div class="border-line border-t p-2">
				<div class="text-faint mb-1 px-1 text-[10px] font-semibold tracking-wider uppercase">Class (1–9)</div>
				<div class="flex flex-wrap gap-1">
					{#each classNames as name, index (name)}
						<button
							type="button"
							onclick={() => assignLabel(name)}
							class="rounded px-2 py-1 text-xs {selectedRegion.label === name ? 'bg-primary text-primary-content' : 'bg-surface text-muted hover:bg-hover'}"
						>
							{#if index < 9}<span class="text-faint mr-1 font-mono text-[10px]">{index + 1}</span>{/if}{name}
						</button>
					{/each}
				</div>
			</div>
		{/if}
	</div>
</div>
