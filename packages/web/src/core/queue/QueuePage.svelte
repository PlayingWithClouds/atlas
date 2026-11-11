<script lang="ts">
	import type { AnnotationInput, ItemPage, ItemStatus, ItemView, QueueNext } from '@atlas/contracts';
	import { onMount, untrack } from 'svelte';
	import { kernelContext } from '../../kernel/context';
	import EmptyState from '../../lib/components/EmptyState.svelte';
	import { messageOf } from '../shared/errors';
	import PageHeader from '../shared/PageHeader.svelte';
	import ItemCard from './ItemCard.svelte';
	import { apiItemPath, labelPath } from './itemLink';
	import ArrowCounterClockwiseIcon from 'phosphor-svelte/lib/ArrowCounterClockwise';
	import EyeSlashIcon from 'phosphor-svelte/lib/EyeSlash';
	import PlayIcon from 'phosphor-svelte/lib/Play';
	import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeft';
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRight';

	let { params }: { params: Record<string, string> } = $props();

	type Filter = ItemStatus | 'all';

	const PAGE_SIZE = 48;
	const RELOAD_DELAY_MS = 300;
	const FILTERS: { value: Filter; label: string }[] = [
		{ value: 'all', label: 'All' },
		{ value: 'pending', label: 'Pending' },
		{ value: 'labeled', label: 'Labeled' },
		{ value: 'skipped', label: 'Skipped' }
	];

	const ctx = kernelContext();

	let filter = $state<Filter>('pending');
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

	function itemsQuery(): string {
		const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
		if (filter !== 'all') {
			query.set('status', filter);
		}
		if (currentCursor !== undefined) {
			query.set('cursor', currentCursor);
		}
		return query.toString();
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
			const next = await ctx.api.get<QueueNext>(`/projects/${encodeURIComponent(projectId)}/queue/next`);
			if (next.item === undefined) {
				ctx.toasts.push('Nothing pending: the queue is empty', 'info');
				return;
			}
			ctx.router.navigate(labelPath(projectId, next.item.item.id));
		} catch (failure) {
			ctx.toasts.push(messageOf(failure), 'error');
		} finally {
			starting = false;
		}
	}

	$effect(() => {
		void projectId;
		untrack(() => firstPage());
	});

	onMount(() => {
		const unsubscribe = ctx.live.subscribe((signal) => {
			if (signal.type === 'connected') {
				scheduleReload();
				return;
			}
			if (signal.type === 'projects' || signal.type === 'taxonomy') return;
			if (signal.projectId === projectId) {
				scheduleReload();
			}
		});
		return () => {
			unsubscribe();
			clearTimeout(reloadTimer);
		};
	});
</script>

<svelte:window onkeydown={onKeydown} />

<div class="p-6">
	<PageHeader title="Queue" {subtitle}>
		{#snippet actions()}
			<button type="button" class="btn btn-primary" disabled={starting || pendingCount === 0} onclick={startLabeling}>
				<PlayIcon size={14} weight="fill" /> Start labeling
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

	{#if error}<div class="alert alert-error mb-3">{error}</div>{/if}

	{#if loading}
		<div class="text-dim flex justify-center py-16"><span class="loading"></span></div>
	{:else if page.items.length === 0}
		<EmptyState title="No items here" hint="Adapters push items to /api/projects/{projectId}/items; they show up here live." />
	{:else}
		<div class="grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax(240px, 1fr))">
			{#each page.items as view (view.item.id)}
				<ItemCard
					{projectId}
					{view}
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
