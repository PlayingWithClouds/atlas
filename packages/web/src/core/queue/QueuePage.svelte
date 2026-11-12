<script lang="ts">
	import type { AnnotationInput, ItemPage, ItemStatus, ItemView, Project, QueueNext, Taxonomy } from '@atlas/contracts';
	import { onMount, untrack } from 'svelte';
	import { kernelContext } from '../../kernel/context';
	import EmptyState from '../../lib/components/EmptyState.svelte';
	import Select from '../../lib/components/Select.svelte';
	import { messageOf } from '../shared/errors';
	import PageHeader from '../shared/PageHeader.svelte';
	import ItemCard from './ItemCard.svelte';
	import { currentFilter, filterSearch, groupOptions, hasFilter, labelOptions } from './itemFilter';
	import { apiFilterSearch } from './apiFilter';
	import MarginSelect from './MarginSelect.svelte';
	import { settings } from '../settings/settings.svelte';
	import SparkleIcon from 'phosphor-svelte/lib/Sparkle';
	import type { QueueFilter } from './itemFilter';
	import { apiItemPath, labelPath, queuePath } from './itemLink';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';
	import XIcon from 'phosphor-svelte/lib/X';
	import ArrowCounterClockwiseIcon from 'phosphor-svelte/lib/ArrowCounterClockwise';
	import EyeSlashIcon from 'phosphor-svelte/lib/EyeSlash';
	import PlayIcon from 'phosphor-svelte/lib/Play';
	import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeft';
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRight';

	let { params }: { params: Record<string, string> } = $props();

	type Filter = ItemStatus | 'all';

	const PAGE_SIZE = 48;
	const RELOAD_DELAY_MS = 300;
	const SEARCH_DELAY_MS = 250;
	/** Each change of the description asks the adapter; wait for a pause in typing. */
	const SIMILAR_DELAY_MS = 500;
	const SORTS = [
		{ value: 'order', label: 'Push order' },
		{ value: 'queue', label: 'Queue order' },
		{ value: 'match', label: 'Best match' }
	];
	const FILTERS: { value: Filter; label: string }[] = [
		{ value: 'all', label: 'All' },
		{ value: 'pending', label: 'Pending' },
		{ value: 'labeled', label: 'Labeled' },
		{ value: 'skipped', label: 'Skipped' }
	];

	const ctx = kernelContext();

	let filter = $state<Filter>('pending');
	/** Search, label, unsure and sort; mirrored into the page URL so labeling keeps it. */
	let narrowing = $state<QueueFilter>(currentFilter());
	let searchText = $state(initialSearchText());
	let similarText = $state(initialSimilarText());
	let similarTimer: ReturnType<typeof setTimeout> | undefined;
	/** The adapter can rank items by a description (the project has semanticSearch). */
	let canSearchScenes = $state(false);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let taxonomy = $state<Taxonomy | undefined>(undefined);
	let page = $state<ItemPage>({ items: [] });
	/** Cursor that opened each earlier page; the first page has none. */
	let earlierCursors = $state<(string | undefined)[]>([]);
	let currentCursor = $state<string | undefined>(undefined);
	let loading = $state(true);
	let error = $state('');
	let starting = $state(false);
	let selectedIds = $state<string[]>([]);
	/** The card a Shift-click extends the selection from. */
	let anchorId: string | undefined;
	let changing = $state(false);
	let loadCounter = 0;
	let reloadTimer: ReturnType<typeof setTimeout> | undefined;

	const projectId = $derived(params.project);
	const summary = $derived(ctx.projects.find(projectId));
	const pendingCount = $derived.by(() => {
		if (summary === undefined) {
			return 0;
		}
		return summary.items - summary.labeled - summary.skipped;
	});
	const subtitle = $derived.by(() => {
		if (summary === undefined) {
			return '';
		}
		return `${summary.items} items · ${pendingCount} pending · ${summary.labeled} labeled · ${summary.skipped} skipped`;
	});

	const narrowed = $derived(hasFilter(narrowing));
	const labelChoices = $derived.by(() => {
		if (taxonomy === undefined) return [];
		return [{ value: '', label: 'Any label' }, ...labelOptions(taxonomy)];
	});
	const unsureChoices = $derived.by(() => {
		if (taxonomy === undefined) return [];
		return [{ value: '', label: 'Anything' }, ...groupOptions(taxonomy), ...labelOptions(taxonomy)];
	});

	function initialSearchText(): string {
		const search = currentFilter().q;
		if (search === undefined) {
			return '';
		}
		return search;
	}

	function itemsQuery(): string {
		const extra: Record<string, string> = { limit: String(PAGE_SIZE) };
		if (filter !== 'all') {
			extra.status = filter;
		}
		if (currentCursor !== undefined) {
			extra.cursor = currentCursor;
		}
		return apiFilterSearch(narrowing, extra).slice(1);
	}

	function initialSimilarText(): string {
		const similar = currentFilter().similar;
		if (similar === undefined) {
			return '';
		}
		return similar;
	}

	function onSimilarInput() {
		clearTimeout(similarTimer);
		similarTimer = setTimeout(() => narrow({ similar: similarText.trim() }), SIMILAR_DELAY_MS);
	}

	/** "604 match · 412 pending" for a narrowed list. */
	const matchSummary = $derived.by(() => {
		if (!narrowed || page.total === undefined) {
			return '';
		}
		return `${page.total} match · ${page.pending} pending`;
	});

	const labelButtonText = $derived.by(() => {
		if (!narrowed) {
			return 'Start labeling';
		}
		if (page.pending === undefined) {
			return 'Label these';
		}
		return `Label these ${page.pending}`;
	});

	/** Applies a filter change: the URL follows, the list starts again at page 1. */
	function narrow(change: QueueFilter) {
		const next: QueueFilter = { ...narrowing, ...change };
		const narrowsByModel = Boolean(change.label) || Boolean(change.unsure) || Boolean(change.similar);
		if (narrowsByModel && next.sort === undefined) {
			next.sort = 'match';
		}
		narrowing = next;
		history.replaceState(null, '', queuePath(projectId) + filterSearch(narrowing));
		clearSelection();
		firstPage();
	}

	function onSearchInput() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => narrow({ q: searchText.trim() }), SEARCH_DELAY_MS);
	}

	function clearNarrowing() {
		searchText = '';
		similarText = '';
		narrowing = {};
		narrow({});
	}

	async function loadTaxonomy() {
		try {
			const project = await ctx.api.get<Project>(`/projects/${encodeURIComponent(projectId)}`);
			taxonomy = project.taxonomy;
			canSearchScenes = project.semanticSearch !== undefined;
		} catch (failure) {
			error = messageOf(failure);
		}
	}

	function selectValue(value: string | undefined, fallback: string): string {
		if (value === undefined) {
			return fallback;
		}
		return value;
	}

	async function load() {
		loadCounter += 1;
		const thisLoad = loadCounter;
		try {
			const loaded = await ctx.api.get<ItemPage>(`/projects/${encodeURIComponent(projectId)}/items?${itemsQuery()}`);
			if (thisLoad !== loadCounter) return;
			page = loaded;
			error = '';
		} catch (failure) {
			if (thisLoad !== loadCounter) return;
			error = messageOf(failure);
		}
		loading = false;
	}

	function firstPage() {
		earlierCursors = [];
		currentCursor = undefined;
		loading = true;
		void load();
	}

	function nextPage() {
		if (page.cursor === undefined) return;
		clearSelection();
		earlierCursors = [...earlierCursors, currentCursor];
		currentCursor = page.cursor;
		void load();
	}

	function previousPage() {
		if (earlierCursors.length === 0) return;
		clearSelection();
		currentCursor = earlierCursors[earlierCursors.length - 1];
		earlierCursors = earlierCursors.slice(0, -1);
		void load();
	}

	function chooseFilter(next: Filter) {
		filter = next;
		clearSelection();
		firstPage();
	}

	const SKIP: AnnotationInput = { status: 'skipped', values: {}, reviewed: [] };

	const selectedViews = $derived(page.items.filter((view) => selectedIds.includes(view.item.id)));
	const skippable = $derived(selectedViews.filter((view) => view.status === 'pending'));
	const restorable = $derived(selectedViews.filter((view) => view.status === 'skipped'));

	function clearSelection() {
		selectedIds = [];
		anchorId = undefined;
	}

	function toggleSelected(itemId: string, extend: boolean) {
		if (extend && anchorId !== undefined) {
			selectRange(anchorId, itemId);
			return;
		}
		anchorId = itemId;
		if (selectedIds.includes(itemId)) {
			selectedIds = selectedIds.filter((id) => id !== itemId);
			return;
		}
		selectedIds = [...selectedIds, itemId];
	}

	/** Adds every card between the two, in page order, to the selection. */
	function selectRange(fromId: string, toId: string) {
		const ids = page.items.map((view) => view.item.id);
		const from = ids.indexOf(fromId);
		const to = ids.indexOf(toId);
		if (from < 0 || to < 0) return;
		const between = ids.slice(Math.min(from, to), Math.max(from, to) + 1);
		selectedIds = [...new Set([...selectedIds, ...between])];
	}

	function selectPage() {
		selectedIds = page.items.map((view) => view.item.id);
	}

	/** Skipping is an annotation like any other: adapters see it in the feed and stop suggesting. */
	async function skip(views: ItemView[]) {
		await change(views, (view) => ctx.api.put(`${apiItemPath(projectId, view.item.id)}/annotation`, SKIP), 'Skipped');
	}

	async function restore(views: ItemView[]) {
		await change(views, (view) => ctx.api.delete(`${apiItemPath(projectId, view.item.id)}/annotation`), 'Back to pending:');
	}

	async function change(views: ItemView[], request: (view: ItemView) => Promise<unknown>, verb: string) {
		if (views.length === 0 || changing) return;
		changing = true;
		try {
			await Promise.all(views.map(request));
			ctx.toasts.push(`${verb} ${countOf(views.length)}`, 'success');
			clearSelection();
		} catch (failure) {
			ctx.toasts.push(messageOf(failure), 'error');
		} finally {
			changing = false;
			void load();
		}
	}

	function countOf(count: number): string {
		if (count === 1) {
			return '1 item';
		}
		return `${count} items`;
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && selectedIds.length > 0) {
			clearSelection();
		}
	}

	function scheduleReload() {
		clearTimeout(reloadTimer);
		reloadTimer = setTimeout(() => void load(), RELOAD_DELAY_MS);
	}

	async function startLabeling() {
		starting = true;
		try {
			const next = await ctx.api.get<QueueNext>(
				`/projects/${encodeURIComponent(projectId)}/queue/next${apiFilterSearch(narrowing)}`
			);
			if (next.item === undefined) {
				ctx.toasts.push(emptyQueueMessage(), 'info');
				return;
			}
			ctx.router.navigate(labelPath(projectId, next.item.item.id) + filterSearch(narrowing));
		} catch (failure) {
			ctx.toasts.push(messageOf(failure), 'error');
		} finally {
			starting = false;
		}
	}

	function emptyQueueMessage(): string {
		if (narrowed) {
			return 'Nothing pending matches these filters';
		}
		return 'Nothing pending: the queue is empty';
	}

	// A new unsure margin changes what an unsure filter lets through.
	let lastMargin = settings.value.unsureMargin;
	$effect(() => {
		const margin = settings.value.unsureMargin;
		if (margin === lastMargin) return;
		lastMargin = margin;
		untrack(() => {
			if (narrowing.unsure !== undefined) firstPage();
		});
	});

	$effect(() => {
		void projectId;
		untrack(() => {
			firstPage();
			void loadTaxonomy();
		});
	});

	onMount(() => {
		const unsubscribe = ctx.live.subscribe((signal) => {
			if (signal.type === 'connected') {
				scheduleReload();
				return;
			}
			if (signal.type === 'taxonomy' && signal.projectId === projectId) {
				taxonomy = signal.taxonomy;
				return;
			}
			if (signal.type === 'projects' || signal.type === 'taxonomy' || signal.type === 'settings') return;
			if (signal.projectId === projectId) {
				scheduleReload();
			}
		});
		return () => {
			unsubscribe();
			clearTimeout(reloadTimer);
			clearTimeout(searchTimer);
			clearTimeout(similarTimer);
		};
	});
</script>

<svelte:window onkeydown={onKeydown} />

<div class="p-6">
	<PageHeader title="Queue" {subtitle}>
		{#snippet actions()}
			<button type="button" class="btn btn-primary" disabled={starting || pendingCount === 0} onclick={startLabeling}>
				<PlayIcon size={14} weight="fill" />
				{labelButtonText}
			</button>
		{/snippet}
	</PageHeader>

	<div class="mb-4 flex items-center gap-3">
		<div class="tabs tabs-box">
			{#each FILTERS as option (option.value)}
				<button type="button" class="tab {filter === option.value ? 'tab-active' : ''}" onclick={() => chooseFilter(option.value)}>
					{option.label}
				</button>
			{/each}
		</div>
		{#if selectedIds.length > 0}
			<div class="border-line bg-surface flex items-center gap-1 rounded-lg border py-0.5 pr-0.5 pl-3">
				<span class="text-default mr-2 text-sm"><span class="font-semibold">{selectedIds.length}</span> selected</span>
				{#if skippable.length > 0}
					<button type="button" class="btn btn-sm" disabled={changing} onclick={() => void skip(skippable)}>
						<EyeSlashIcon size={13} /> Skip {skippable.length}
					</button>
				{/if}
				{#if restorable.length > 0}
					<button type="button" class="btn btn-sm" disabled={changing} onclick={() => void restore(restorable)}>
						<ArrowCounterClockwiseIcon size={13} /> Restore {restorable.length}
					</button>
				{/if}
				<button type="button" class="btn btn-ghost btn-sm" onclick={selectPage}>Select page</button>
				<button type="button" class="btn btn-ghost btn-sm" onclick={clearSelection} title="Esc">Clear</button>
			</div>
		{:else if page.items.length > 0}
			<span class="text-faint text-xs">Shift-click or tick cards to select several</span>
		{/if}
		<div class="ml-auto flex items-center gap-1">
			<button type="button" class="btn btn-ghost btn-sm btn-square" disabled={earlierCursors.length === 0} onclick={previousPage} aria-label="Previous page">
				<CaretLeftIcon size={14} />
			</button>
			<span class="text-dim w-14 text-center text-xs">Page {earlierCursors.length + 1}</span>
			<button type="button" class="btn btn-ghost btn-sm btn-square" disabled={page.cursor === undefined} onclick={nextPage} aria-label="Next page">
				<CaretRightIcon size={14} />
			</button>
		</div>
	</div>

	<div class="mb-4 flex flex-wrap items-center gap-2">
		{#if canSearchScenes}
			<label class="relative w-72" title="Items the project's search adapter finds for the description, best match first">
				<span class="text-violet pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"><SparkleIcon size={14} /></span>
				<input
					class="input input-sm pl-8"
					placeholder="Describe what to find"
					bind:value={similarText}
					oninput={onSimilarInput}
					aria-label="Search items by description"
				/>
			</label>
		{/if}
		<label class="relative w-56">
			<span class="text-faint pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"><MagnifyingGlassIcon size={14} /></span>
			<input
				class="input input-sm pl-8"
				placeholder="Search titles and ids"
				bind:value={searchText}
				oninput={onSearchInput}
				aria-label="Search"
			/>
		</label>
		<div class="flex items-center gap-1.5">
			<span class="text-dim text-xs" title="Labeled with it, or the model gives it at least 50%">Label</span>
			<div class="w-56">
				<Select value={selectValue(narrowing.label, '')} options={labelChoices} onChange={(value) => narrow({ label: value })} placeholder="Any label" searchable />
			</div>
		</div>
		<div class="flex items-center gap-1.5">
			<span class="text-dim text-xs">Model unsure about</span>
			<div class="w-56">
				<Select value={selectValue(narrowing.unsure, '')} options={unsureChoices} onChange={(value) => narrow({ unsure: value })} placeholder="Anything" searchable />
			</div>
			{#if narrowing.unsure}
				<MarginSelect />
			{/if}
		</div>
		<div class="w-36">
			<Select value={selectValue(narrowing.sort, 'order')} options={SORTS} onChange={(value) => narrow({ sort: value })} />
		</div>
		{#if narrowed}
			<button type="button" class="btn btn-ghost btn-sm" onclick={clearNarrowing}><XIcon size={13} /> Clear filters</button>
			{#if matchSummary}<span class="text-dim ml-auto text-xs">{matchSummary}</span>{/if}
		{/if}
	</div>

	{#if error}<div class="alert alert-error mb-3">{error}</div>{/if}

	{#if loading}
		<div class="text-dim flex justify-center py-16"><span class="loading"></span></div>
	{:else if page.items.length === 0}
		{#if narrowed}
			<EmptyState title="Nothing matches" hint="Loosen the filters above, or clear them." />
		{:else}
			<EmptyState title="No items here" hint="Adapters push items to /api/projects/{projectId}/items; they show up here live." />
		{/if}
	{:else}
		<div class="grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax(240px, 1fr))">
			{#each page.items as view (view.item.id)}
				<ItemCard
					{projectId}
					{view}
					search={filterSearch(narrowing)}
					selected={selectedIds.includes(view.item.id)}
					selecting={selectedIds.length > 0}
					onselect={(extend) => toggleSelected(view.item.id, extend)}
					onskip={() => void skip([view])}
					onrestore={() => void restore([view])}
				/>
			{/each}
		</div>
	{/if}
</div>
