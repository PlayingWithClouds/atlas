<script lang="ts">
	// Grid of temporal spans (video clips). Same selection / batch-tag / skip / delete
	// flow and keyboard map as SessionGrid, but a cell can play its range instead of
	// showing a still. Every cell renders a cached poster frame; playback is bounded,
	// since a <video> per cell costs a decoder and a connection — by default only the
	// hovered clip loops, and autoplay mode caps at MAX_ACTIVE_CLIPS visible ones.
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { listImages, findDuplicates, imageUrl, posterUrl, postLabel, postSkip, deleteImage, searchSession } from '$lib/api/label';
	import { sessionStatus } from '$lib/api/sessions';
	import { sessions as sessionsStore } from '$lib/stores/sessions';
	import { notifications, toasts } from '$lib/stores/notifications';
	import TagGrid from '$lib/components/TagGrid.svelte';
	import Select from '$lib/components/Select.svelte';
	import Key from '$lib/components/Key.svelte';
	import ClipPlayer from '$lib/session/ClipPlayer.svelte';
	import RunWorkflow from '$lib/session/RunWorkflow.svelte';
	import { clipPlayback, formatRange, isClipPlayback } from '$lib/session/clip';
	import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
	import type { SessionStatus, GridItem } from '$lib/api/types';

	let { sid, status: initialStatus }: { sid: string; status: SessionStatus } = $props();

	const project = $derived($page.params.project ?? 'nsfw-tags');
	let status = $state<SessionStatus>(initialStatus);

	async function refreshStatus() {
		try {
			status = await sessionStatus(sid);
		} catch {
			// ignore
		}
	}

	// --- grid ----------------------------------------------------------------
	let items = $state<GridItem[]>([]);
	let hideFinished = $state(false);
	let gridSort = $state<'natural' | 'uncertainty'>('natural');
	let gridLoading = $state(false);

	// Text search reorders the grid to what matched, rather than filtering the list the
	// server returns: the clips are the same clips, seen in a different order.
	let searchQuery = $state('');
	let searchNote = $state('');
	let searching = $state(false);
	let searchOrder = $state<number[] | null>(null);

	const shown = $derived.by(() => {
		if (!searchOrder) return items;
		const byIdx = new Map(items.map((item) => [item.id, item]));
		return searchOrder.map((idx) => byIdx.get(idx)).filter((item) => item !== undefined);
	});

	async function runSearch() {
		const query = searchQuery.trim();
		if (!query) {
			clearSearch();
			return;
		}
		searching = true;
		try {
			const result = await searchSession(sid, query);
			searchOrder = result.hits.map((hit) => hit.idx);
			searchNote = result.hits.length === 0
				? 'nothing matched'
				: `${result.hits.length} best matches of ${result.scored} embedded` +
					(result.unembedded > 0 ? ` · ${result.unembedded} not embedded yet` : '');
			if (result.message) searchNote = result.message;
		} catch (error) {
			searchOrder = null;
			searchNote = (error as Error).message;
		} finally {
			searching = false;
		}
	}

	function clearSearch() {
		searchQuery = '';
		searchOrder = null;
		searchNote = '';
	}

	const borderFor: Record<string, string> = {
		labeled: 'var(--ctx-green)',
		skipped: 'var(--text-faint)',
		pending: 'transparent'
	};

	async function loadGrid() {
		gridLoading = true;
		items = await listImages(sid, hideFinished ? 'unfinished' : 'all', gridSort);
		gridLoading = false;
	}

	// Background refresh: update existing items in place and append new ones, so
	// live updates never blank the grid or reset the scroll position.
	async function refreshGrid() {
		if (gridLoading) return;
		const fresh = await listImages(sid, hideFinished ? 'unfinished' : 'all', gridSort);
		items = mergeItems(items, fresh);
	}

	function mergeItems(current: GridItem[], fresh: GridItem[]): GridItem[] {
		const freshById = new Map(fresh.map((item) => [item.id, item]));
		const merged: GridItem[] = [];
		for (const item of current) {
			const updated = freshById.get(item.id);
			if (!updated) continue;
			merged.push(updated);
			freshById.delete(item.id);
		}
		for (const item of fresh) {
			if (freshById.has(item.id)) merged.push(item);
		}
		return merged;
	}

	function openImage(id: number) {
		goto(`/projects/${project}/session/${sid}/${id}`);
	}

	// --- playback budget -----------------------------------------------------
	// Concurrent <video> elements are expensive (decoders, and ~6 connections per
	// host), so only the visible clips play, capped and in DOM order.
	const MAX_ACTIVE_CLIPS = 12;

	// Hover by default: every cell shows its cached poster, so the grid reads fine
	// without playing anything, and playback follows the clip actually being looked at.
	let playMode = $state<'visible' | 'hover'>('hover');
	let visibleIds = $state<Set<number>>(new Set());
	let hoveredId = $state<number | null>(null);
	let tabHidden = $state(false);

	// A source that has to be cut clip by clip costs one ffmpeg process per playing
	// cell, so autoplay is not offered there.
	const forcedHover = $derived(isClipPlayback(status));
	const effectiveMode = $derived(forcedHover ? 'hover' : playMode);

	const activeIds = $derived.by(() => {
		if (tabHidden) return new Set<number>();
		if (effectiveMode === 'hover') {
			return hoveredId === null ? new Set<number>() : new Set([hoveredId]);
		}
		const active = new Set<number>();
		for (const item of items) {
			if (active.size >= MAX_ACTIVE_CLIPS) break;
			if (visibleIds.has(item.id)) active.add(item.id);
		}
		return active;
	});

	let observer: IntersectionObserver | null = null;

	function observe(node: HTMLElement, id: number) {
		if (!observer) {
			observer = new IntersectionObserver(
				(entries) => {
					const next = new Set(visibleIds);
					for (const entry of entries) {
						const entryId = Number((entry.target as HTMLElement).dataset.clipId);
						if (entry.isIntersecting) next.add(entryId);
						else next.delete(entryId);
					}
					visibleIds = next;
				},
				{ rootMargin: '200px', threshold: 0.1 }
			);
		}
		node.dataset.clipId = String(id);
		observer.observe(node);
		return {
			destroy() {
				observer?.unobserve(node);
				const next = new Set(visibleIds);
				next.delete(id);
				visibleIds = next;
			}
		};
	}

	function onVisibilityChange() {
		tabHidden = document.visibilityState === 'hidden';
	}

	// --- multi-select + batch assign -----------------------------------------
	let selectedIds = $state<Set<number>>(new Set());
	let anchorPos = $state<number | null>(null);
	let batchOpen = $state(false);
	let batchTags = $state<Set<string>>(new Set());
	// Tags carried by part of the selection: shown apart from the checked ones, since
	// applying them would label clips that never had them.
	let batchPartial = $state<Set<string>>(new Set());
	// What the panel opened with, so unchecking a tag it pre-filled removes that tag
	// instead of quietly surviving the merge with the entity's existing labels.
	let batchSeeded = $state<Set<string>>(new Set());
	let batchReplace = $state(false);
	let batchBusy = $state(false);

	function toggleSelect(id: number) {
		const next = new Set(selectedIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selectedIds = next;
	}

	function onGridClick(pos: number, event: MouseEvent) {
		const id = items[pos].id;
		if (event.shiftKey) {
			if (anchorPos === null) {
				anchorPos = pos;
				selectedIds = new Set([id]);
			} else {
				const [a, b] = anchorPos <= pos ? [anchorPos, pos] : [pos, anchorPos];
				const next = new Set<number>();
				for (let k = a; k <= b; k++) next.add(items[k].id);
				selectedIds = next;
			}
		} else if (selectedIds.size) {
			toggleSelect(id);
			anchorPos = pos;
		} else {
			openImage(id);
		}
	}

	function clearSelection() {
		selectedIds = new Set();
		anchorPos = null;
	}

	// The panel opens from what the selection already carries, so an edit starts from
	// the current labels instead of blank: tags on every selected clip come in
	// checked, tags on only some are offered separately rather than silently applied.
	function openBatch() {
		if (!selectedIds.size) return;
		const selection = items.filter((item) => selectedIds.has(item.id));
		batchTags = tagsOnEvery(selection);
		batchSeeded = new Set(batchTags);
		batchPartial = tagsOnSome(selection, batchTags);
		batchReplace = false;
		batchQuery = '';
		batchOpen = true;
	}

	function tagsOnEvery(selection: GridItem[]): Set<string> {
		if (!selection.length) return new Set();
		const common = new Set(selection[0].tags);
		for (const item of selection.slice(1)) {
			const has = new Set(item.tags);
			for (const tag of [...common]) {
				if (!has.has(tag)) common.delete(tag);
			}
		}
		return common;
	}

	function tagsOnSome(selection: GridItem[], common: Set<string>): Set<string> {
		const partial = new Set<string>();
		for (const item of selection) {
			for (const tag of item.tags) {
				if (!common.has(tag)) partial.add(tag);
			}
		}
		return partial;
	}

	// Batch modal search.
	let batchQuery = $state('');
	let batchSearchEl = $state<HTMLInputElement | null>(null);

	const batchSearchResults = $derived.by(() => {
		const q = batchQuery.trim().toLowerCase();
		if (!q) return [];
		return status.classes.filter((c) => c.toLowerCase().includes(q)).slice(0, 9);
	});

	function pickBatch(name: string) {
		toggleBatchTag(name);
		batchQuery = '';
		queueMicrotask(() => batchSearchEl?.focus());
	}

	function onBatchSearchKey(event: KeyboardEvent) {
		if (event.key >= '1' && event.key <= '9') {
			const item = batchSearchResults[Number(event.key) - 1];
			if (item) {
				event.preventDefault();
				pickBatch(item);
			}
		} else if (event.key === 'Enter') {
			event.preventDefault();
			if (batchSearchResults.length) pickBatch(batchSearchResults[0]);
		} else if (event.key === 'Escape' && batchQuery) {
			event.preventDefault();
			event.stopPropagation();
			batchQuery = '';
		}
	}

	$effect(() => {
		if (batchOpen) queueMicrotask(() => batchSearchEl?.focus());
	});

	function toggleBatchTag(name: string) {
		const next = new Set(batchTags);
		if (next.has(name)) next.delete(name);
		else next.add(name);
		batchTags = next;
		// Once chosen deliberately, a tag is no longer "on some of them".
		if (batchPartial.has(name)) {
			const rest = new Set(batchPartial);
			rest.delete(name);
			batchPartial = rest;
		}
	}

	// Merging keeps whatever each entity already had, except the tags the panel
	// pre-filled and the user then unchecked — those were an explicit removal.
	function labelsFor(existing: string[], tags: string[]): string[] {
		if (batchReplace) return tags;
		const removed = new Set([...batchSeeded].filter((tag) => !batchTags.has(tag)));
		const merged = new Set([...existing, ...tags]);
		for (const tag of removed) merged.delete(tag);
		return [...merged];
	}

	async function applyBatch() {
		if (batchBusy) return;
		// Nothing selected and nothing pre-filled means there is no edit to make.
		if (!batchTags.size && !batchSeeded.size) return;
		batchBusy = true;
		const tags = [...batchTags];
		try {
			await Promise.all(
				[...selectedIds].map((id) => {
					const item = items.find((it) => it.id === id);
					const labels = labelsFor(item?.tags ?? [], tags);
					return postLabel(sid, id, labels).then(() => labels);
				})
			);
			items = items.map((it) => {
				if (!selectedIds.has(it.id)) return it;
				const labels = labelsFor(it.tags, tags);
				return { ...it, tags: labels, status: 'labeled' as const };
			});
			batchOpen = false;
			clearSelection();
			await refreshStatus();
		} finally {
			batchBusy = false;
		}
	}

	async function skipSelected() {
		if (!selectedIds.size || batchBusy) return;
		batchBusy = true;
		const ids = [...selectedIds];
		try {
			await Promise.all(ids.map((id) => postSkip(sid, id)));
			clearSelection();
			await refreshStatus();
			await refreshGrid();
		} finally {
			batchBusy = false;
		}
	}

	async function deleteSelected() {
		if (!selectedIds.size || batchBusy) return;
		batchBusy = true;
		const ids = [...selectedIds];
		try {
			await Promise.all(ids.map((id) => deleteImage(sid, id)));
			clearSelection();
			await refreshStatus();
			await refreshGrid();
		} finally {
			batchBusy = false;
		}
	}

	// Select near-duplicate clips so they can be skipped / bulk-labeled at once.
	let dedupBusy = $state(false);
	let dedupMsg = $state('');

	async function selectDuplicates() {
		dedupBusy = true;
		dedupMsg = '';
		try {
			const res = await findDuplicates(sid);
			selectedIds = new Set(res.duplicates);
			anchorPos = null;
			dedupMsg = res.count
				? `${res.count} near-duplicates across ${res.clusters.length} clusters selected`
				: 'No near-duplicates found';
		} finally {
			dedupBusy = false;
		}
	}

	function onKeydown(event: KeyboardEvent) {
		if (batchOpen) {
			if (event.key === 'Escape') {
				event.preventDefault();
				batchOpen = false;
			}
			return;
		}
		if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
		if (!selectedIds.size) return;
		if (event.key === 'l' || event.key === 'L') {
			event.preventDefault();
			openBatch();
		} else if (event.key === 'S' && event.shiftKey) {
			event.preventDefault();
			skipSelected();
		} else if (event.key === 'D' && event.shiftKey) {
			event.preventDefault();
			deleteSelected();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			clearSelection();
		}
	}

	// Live refresh: reload the grid (debounced) when this session's counts change.
	const liveEntry = $derived($sessionsStore.find((s) => s.id === sid));
	let lastSig = '';
	let reloadTimer: ReturnType<typeof setTimeout> | null = null;

	function scheduleViewReload() {
		if (reloadTimer) return;
		reloadTimer = setTimeout(() => {
			reloadTimer = null;
			refreshGrid();
		}, 800);
	}

	$effect(() => {
		const e = liveEntry;
		if (!e) return;
		const sig = `${e.labeled}:${e.skipped}:${e.total}:${e.producing}`;
		if (sig === lastSig) return;
		lastSig = sig;
		refreshStatus();
		scheduleViewReload();
	});

	// Workflows can write annotations without moving any count (e.g. a save node
	// proposing labels), so the signature above never fires. Every workflow run
	// surfaces a toast or persistent notification for its session — use either
	// as a reload signal too.
	let lastNotificationId = '';
	$effect(() => {
		const relevant = [...$notifications, ...$toasts].filter((n) => n.session === sid);
		if (!relevant.length) return;
		const newest = relevant[relevant.length - 1].id;
		if (newest === lastNotificationId) return;
		lastNotificationId = newest;
		refreshStatus();
		scheduleViewReload();
	});

	// (Re)load whenever the session id changes.
	$effect(() => {
		sid;
		untrack(() => {
			status = initialStatus;
			lastSig = '';
			selectedIds = new Set();
			anchorPos = null;
			batchOpen = false;
			hoveredId = null;
			visibleIds = new Set();
			items = [];
			loadGrid();
		});
	});
</script>

<svelte:window onkeydown={onKeydown} />
<svelte:document onvisibilitychange={onVisibilityChange} />

<div class="flex h-full flex-col">
	<header class="border-line bg-elevated flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-5 py-3">
		<div class="min-w-0">
			<div class="text-default truncate text-sm font-semibold">{status.label}</div>
			<div class="text-dim text-xs">
				{status.labeled} labeled · {status.embedded}/{status.total} embedded
				{#if status.producing}· <span class="text-amber">segmenting…</span>{/if}
				{#if status.head_trained}· <span class="text-green">model live</span>{:else}· model warming up{/if}
			</div>
		</div>
		<div class="ml-auto flex items-center gap-3">
			<span class="text-dim text-xs">All {status.total} clips</span>
			<RunWorkflow {sid} />
		</div>
	</header>

	<div class="flex min-h-0 flex-1 flex-col">
		<div class="border-line flex flex-wrap items-center gap-3 border-b px-5 py-2 text-xs">
			<div class="flex items-center gap-2">
				<input
					class="input input-sm w-56"
					type="search"
					placeholder="Find clips: outdoor, close-up…"
					bind:value={searchQuery}
					onkeydown={(event) => {
						if (event.key === 'Enter') runSearch();
						if (event.key === 'Escape') clearSearch();
					}}
				/>
				{#if searching}
					<span class="loading loading-xs"></span>
				{:else if searchOrder}
					<button type="button" class="text-dim hover:text-default" onclick={clearSearch}>clear</button>
				{/if}
				{#if searchNote}
					<span class="text-faint">{searchNote}</span>
				{/if}
			</div>
			<label class="text-dim flex items-center gap-2">
				<input type="checkbox" bind:checked={hideFinished} onchange={loadGrid} /> Hide finished
			</label>
			<div class="text-dim flex items-center gap-2">
				Sort
				<div class="w-44">
					<Select
						value={gridSort}
						onChange={(v) => {
							gridSort = v as 'natural' | 'uncertainty';
							loadGrid();
						}}
						options={[
							{ value: 'natural', label: 'Natural' },
							{ value: 'uncertainty', label: 'Most uncertain' }
						]}
					/>
				</div>
			</div>
			<div class="text-dim flex items-center gap-2" title={forcedHover ? 'This source is cut clip by clip on the server, so clips play on hover only' : 'Hover plays one clip at a time; autoplay loops up to ' + MAX_ACTIVE_CLIPS + ' visible ones'}>
				Playback
				<div class="w-40">
					<Select
						value={effectiveMode}
						disabled={forcedHover}
						onChange={(v) => (playMode = v as 'visible' | 'hover')}
						options={[
							{ value: 'hover', label: 'Play on hover' },
							{ value: 'visible', label: 'Autoplay visible' }
						]}
					/>
				</div>
			</div>
			<button type="button" class="btn btn-xs btn-ghost" onclick={selectDuplicates} disabled={dedupBusy} title="Select near-duplicate clips so they can be skipped or bulk-labeled">
				{dedupBusy ? 'Finding…' : 'Find duplicates'}
			</button>
			{#if dedupMsg && !selectedIds.size}<span class="text-faint">{dedupMsg}</span>{/if}
			{#if selectedIds.size}
				<div class="ml-auto flex items-center gap-2">
					<span class="text-default font-semibold">{selectedIds.size} selected</span>
					<button type="button" class="btn btn-xs btn-primary" onclick={openBatch} disabled={batchBusy}>Assign tags <Key label="L" /></button>
					<button type="button" class="btn btn-xs btn-ghost" onclick={skipSelected} disabled={batchBusy} title="Skip the selected clips">Skip <Key label="⇧S" /></button>
					<button type="button" class="btn btn-xs btn-ghost text-error" onclick={deleteSelected} disabled={batchBusy} title="Delete the selected clips from the session">Delete <Key label="⇧D" /></button>
					<button type="button" class="btn btn-xs btn-ghost" onclick={clearSelection}>Clear <Key label="Esc" /></button>
				</div>
			{:else}
				<span class="text-faint ml-auto hidden sm:inline">Click a clip to label · shift-click to select</span>
			{/if}
		</div>
		<div class="min-h-0 flex-1 overflow-y-auto p-5">
			{#if gridLoading}
				<div class="text-dim flex justify-center py-16"><span class="loading"></span></div>
			{:else}
				<div class="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2">
					{#each shown as item, i (item.id)}
						{@const sel = selectedIds.has(item.id)}
						{@const span = item.t_start !== undefined && item.t_end !== undefined}
						<button
							type="button"
							use:observe={item.id}
							onclick={(e) => onGridClick(i, e)}
							onmouseenter={() => (hoveredId = item.id)}
							onmouseleave={() => {
								if (hoveredId === item.id) hoveredId = null;
							}}
							class="group bg-base-100 relative block aspect-video overflow-hidden rounded-lg border-2 text-left {sel ? 'ring-primary ring-2' : ''}"
							style="border-color: {sel ? 'var(--ctx-blue)' : (borderFor[item.status] ?? 'transparent')}"
							title={item.tags.join(', ')}
						>
							{#if !span}
								<!-- A session can mix extracted frames with clips; render those as stills. -->
								<img src={imageUrl(sid, item.id, status.token)} alt="" class="h-full w-full object-cover" loading="lazy" />
							{:else if activeIds.has(item.id)}
								{@const play = clipPlayback(status, sid, item.id, item.t_start!, item.t_end!, 'grid')}
								<ClipPlayer
									src={play.src}
									start={play.start}
									end={play.end}
									poster={posterUrl(sid, item.id, item.t_start, item.t_end)}
									active
								/>
							{:else}
								<!-- Off the playback budget: the cached mid-clip frame, so the grid reads
								     as clips instead of empty boxes. -->
								<img
									src={posterUrl(sid, item.id, item.t_start, item.t_end)}
									alt={formatRange(item.t_start!, item.t_end!)}
									class="h-full w-full object-cover"
									loading="lazy"
								/>
							{/if}

							{#if span}
								<span class="absolute top-1.5 right-1.5 rounded bg-black/65 px-1.5 py-0.5 font-mono text-[10px] text-white">
									{formatRange(item.t_start!, item.t_end!)}
								</span>
							{/if}
							{#if sel}
								<div class="bg-primary text-primary-content absolute top-1.5 left-1.5 flex h-5 w-5 items-center justify-center rounded-full">
									<CheckIcon size={13} />
								</div>
							{/if}
							{#if item.tags.length}
								<div class="absolute inset-x-0 bottom-0 flex flex-wrap gap-1 bg-gradient-to-t from-black/80 to-transparent p-1.5 pt-6">
									{#each item.tags as tag (tag)}
										<span class="rounded bg-white/20 px-1.5 py-0.5 text-xs font-semibold text-white">{tag}</span>
									{/each}
								</div>
							{/if}
						</button>
					{:else}
						<div class="text-dim col-span-full py-16 text-center text-sm">
							No clips yet — run a workflow with a <span class="text-default font-semibold">Segment video</span> step on this session.
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</div>

{#if selectedIds.size && !batchOpen}
	<div class="border-line bg-elevated fixed right-4 bottom-4 z-40 rounded-lg border p-3 text-xs shadow-lg">
		<div class="text-default mb-2 font-semibold">{selectedIds.size} selected</div>
		<div class="flex flex-col gap-1.5">
			{#each [['L', 'Assign tags'], ['⇧S', 'Skip'], ['⇧D', 'Delete'], ['Esc', 'Clear selection'], ['⇧ Click', 'Extend range'], ['Click', 'Toggle clip']] as [key, desc] (key)}
				<div class="flex items-center gap-2">
					<kbd class="border-line text-dim bg-surface min-w-[3rem] rounded border px-1.5 py-0.5 text-center font-mono text-[10px]">{key}</kbd>
					<span class="text-muted">{desc}</span>
				</div>
			{/each}
		</div>
	</div>
{/if}

{#if batchOpen}
	<div class="fixed inset-0 z-[100] flex" style="background: var(--overlay-scrim)">
		<button type="button" class="absolute inset-0 cursor-default" aria-label="Close" onclick={() => (batchOpen = false)}></button>

		<div class="border-line bg-surface relative z-10 m-auto flex max-h-[88vh] w-[94vw] max-w-4xl flex-col overflow-hidden rounded-xl border shadow-lg">
			<div class="border-line flex items-center justify-between border-b px-4 py-3">
				<h3 class="text-default text-sm font-semibold">Assign tags to {selectedIds.size} clips</h3>
				<div class="flex flex-wrap gap-1.5">
					{#each [...batchTags] as tag (tag)}
						<button type="button" onclick={() => toggleBatchTag(tag)} class="bg-primary text-primary-content flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold" title="Remove">
							{tag} <span class="opacity-60">×</span>
						</button>
					{/each}
					{#each [...batchPartial] as tag (tag)}
						<button
							type="button"
							onclick={() => toggleBatchTag(tag)}
							class="border-line text-dim flex items-center gap-1 rounded-full border border-dashed px-2.5 py-1 text-xs font-semibold"
							title="On some of the selected clips — click to apply to all"
						>
							{tag} <span class="opacity-60">+</span>
						</button>
					{/each}
				</div>
			</div>

			<div class="border-line border-b p-3">
				<input
					bind:this={batchSearchEl}
					bind:value={batchQuery}
					onkeydown={onBatchSearchKey}
					placeholder="Search tags… (1–9 pick)"
					spellcheck="false"
					autocomplete="off"
					class="input input-sm w-full"
				/>
				{#if batchSearchResults.length}
					<div class="mt-2 flex flex-col gap-0.5">
						{#each batchSearchResults as name, i (name)}
							{@const on = batchTags.has(name)}
							<button
								type="button"
								onclick={() => pickBatch(name)}
								class="flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm {on ? 'bg-primary text-primary-content' : 'hover:bg-hover text-default'}"
							>
								<span class="font-mono text-[11px] {on ? 'opacity-70' : 'text-faint'}">{i + 1}</span>
								<span class="flex-1">{name}</span>
							</button>
						{/each}
					</div>
				{/if}
			</div>

			<div class="min-h-0 flex-1 overflow-y-auto p-4">
				<TagGrid classes={status.classes} selected={batchTags} suggestions={{}} threshold={0.5} onToggle={toggleBatchTag} />
			</div>

			<div class="border-line flex items-center gap-3 border-t p-3">
				<label class="text-dim flex items-center gap-2 text-xs">
					<input type="checkbox" bind:checked={batchReplace} /> Replace existing (else add)
				</label>
				<button type="button" class="btn btn-sm btn-ghost ml-auto" onclick={() => (batchOpen = false)}>Cancel</button>
				<button
					type="button"
					class="btn btn-sm btn-primary"
					disabled={(!batchTags.size && !batchSeeded.size) || batchBusy}
					onclick={applyBatch}
				>
					{batchReplace ? 'Replace on' : 'Save to'} {selectedIds.size}
				</button>
			</div>
		</div>
	</div>
{/if}
