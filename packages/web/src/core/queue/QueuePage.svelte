<script lang="ts">
	import type { ItemPage, ItemStatus, QueueNext } from '@atlas/contracts';
	import { onMount, untrack } from 'svelte';
	import { kernelContext } from '../../kernel/context';
	import EmptyState from '../../lib/components/EmptyState.svelte';
	import { messageOf } from '../shared/errors';
	import PageHeader from '../shared/PageHeader.svelte';
	import ItemCard from './ItemCard.svelte';
	import { labelPath } from './itemLink';
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
		earlierCursors = [...earlierCursors, currentCursor];
		currentCursor = page.cursor;
		void load();
	}

	function previousPage() {
		if (earlierCursors.length === 0) return;
		currentCursor = earlierCursors[earlierCursors.length - 1];
		earlierCursors = earlierCursors.slice(0, -1);
		void load();
	}

	function chooseFilter(next: Filter) {
		filter = next;
		firstPage();
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
				<ItemCard {projectId} {view} />
			{/each}
		</div>
	{/if}
</div>
