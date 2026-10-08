<script lang="ts">
	import type { Item, Project, Session } from '@atlas/contracts';
	import { Key, MediaGrid, Select } from '@atlas/web/components';
	import { kernelContext } from '@atlas/web/kernel';
	import { onMount, untrack } from 'svelte';
	import BatchTagDialog from './BatchTagDialog.svelte';
	import { gridActionForKey } from './keyboardMap';
	import {
		confirmAnnotations,
		deleteItem,
		findDuplicateIds,
		listItems,
		modelSupportsTextSearch,
		searchItemIds,
		skipItem
	} from './labelApi';
	import type { GridSort } from './labelApi';
	import { annotationsWithTags, labelsAfterBatch, tagsOf } from './itemTags';
	import type { BatchEdit } from './itemTags';
	import { resolveClick } from './selection';

	let { project, session }: { project: Project; session: Session } = $props();

	const ctx = kernelContext();
	const RELOAD_DELAY_MS = 800;

	let items = $state.raw<Item[]>([]);
	let loading = $state(false);
	let error = $state('');
	let hideFinished = $state(false);
	let sort = $state<GridSort>('natural');
	let selectedIds = $state<Set<string>>(new Set());
	let anchorPosition = $state<number | null>(null);
	let batchOpen = $state(false);
	let busy = $state(false);
	let duplicateMessage = $state('');
	let textSearchSupported = $state(false);
	let searchQuery = $state('');
	let reloadTimer: ReturnType<typeof setTimeout> | undefined;

	const selectedItems = $derived(items.filter((item) => selectedIds.has(item.id)));
	const applicableActions = $derived(
		ctx.toolbarActions.list().filter((action) => action.when(project, session))
	);
	const progressKey = $derived.by(() => {
		const summary = ctx.live.sessions.find((candidate) => candidate.id === session.id);
		if (!summary) {
			return 'none';
		}
		return `${summary.total}:${summary.labeled}:${summary.skipped}:${summary.producing}`;
	});

	function failWith(failure: unknown) {
		error = failure instanceof Error ? failure.message : String(failure);
	}

	async function fetchVisible(): Promise<Item[]> {
		const query = searchQuery.trim();
		if (query === '') {
			return listItems(ctx.api, session.id, hideFinished, sort);
		}
		const [all, rankedIds] = await Promise.all([
			listItems(ctx.api, session.id, hideFinished, sort),
			searchItemIds(ctx.api, session.id, query)
		]);
		const byId = new Map(all.map((item) => [item.id, item]));
		return rankedIds.map((id) => byId.get(id)).filter((item): item is Item => item !== undefined);
	}

	async function load() {
		loading = true;
		error = '';
		try {
			items = await fetchVisible();
		} catch (failure) {
			failWith(failure);
		} finally {
			loading = false;
		}
	}

	// Background refresh keeps existing items in place so live updates never reset scrolling.
	async function refresh() {
		if (loading) return;
		try {
			items = mergeItems(items, await fetchVisible());
		} catch (failure) {
			failWith(failure);
		}
	}

	function mergeItems(current: Item[], fresh: Item[]): Item[] {
		const freshById = new Map(fresh.map((item) => [item.id, item]));
		const merged: Item[] = [];
		for (const item of current) {
			const updated = freshById.get(item.id);
			if (updated) {
				merged.push(updated);
				freshById.delete(item.id);
			}
		}
		for (const item of fresh) {
			if (freshById.has(item.id)) {
				merged.push(item);
			}
		}
		return merged;
	}

	function scheduleRefresh() {
		if (reloadTimer !== undefined) return;
		reloadTimer = setTimeout(() => {
			reloadTimer = undefined;
			void refresh();
		}, RELOAD_DELAY_MS);
	}

	onMount(() => {
		modelSupportsTextSearch(ctx.api, project.config.model)
			.then((supported) => (textSearchSupported = supported))
			.catch(() => (textSearchSupported = false));
		return () => clearTimeout(reloadTimer);
	});

	let lastProgressKey = '';
	$effect(() => {
		const key = progressKey;
		if (key === lastProgressKey) return;
		const firstRun = lastProgressKey === '';
		lastProgressKey = key;
		untrack(() => {
			if (firstRun) {
				void load();
				return;
			}
			scheduleRefresh();
		});
	});

	function openItem(item: Item) {
		ctx.router.navigate(`/projects/${project.id}/session/${session.id}/${item.id}`);
	}

	function onSelect(item: Item, event: MouseEvent) {
		const position = items.findIndex((candidate) => candidate.id === item.id);
		const outcome = resolveClick(
			items.map((candidate) => candidate.id),
			position,
			{ selectedIds, anchorPosition },
			event
		);
		if (outcome.kind === 'open') {
			openItem(item);
			return;
		}
		selectedIds = outcome.state.selectedIds;
		anchorPosition = outcome.state.anchorPosition;
	}

	function clearSelection() {
		selectedIds = new Set();
		anchorPosition = null;
	}

	async function runOnSelection(task: (item: Item) => Promise<unknown>) {
		if (busy || selectedItems.length === 0) return;
		busy = true;
		try {
			await Promise.all(selectedItems.map(task));
			clearSelection();
			await refresh();
		} catch (failure) {
			failWith(failure);
		} finally {
			busy = false;
		}
	}

	function skipSelected() {
		return runOnSelection((item) => skipItem(ctx.api, item.id));
	}

	function deleteSelected() {
		return runOnSelection((item) => deleteItem(ctx.api, item.id));
	}

	async function applyBatch(edit: BatchEdit) {
		await runOnSelection((item) => {
			const labels = labelsAfterBatch(tagsOf(item), edit);
			return confirmAnnotations(ctx.api, item.id, annotationsWithTags(item, labels));
		});
		batchOpen = false;
	}

	async function selectDuplicates() {
		busy = true;
		duplicateMessage = '';
		try {
			const duplicateIds = await findDuplicateIds(ctx.api, session.id);
			selectedIds = new Set(duplicateIds);
			anchorPosition = null;
			duplicateMessage = duplicateIds.length > 0 ? `${duplicateIds.length} near-duplicates selected` : 'No near-duplicates found';
		} catch (failure) {
			failWith(failure);
		} finally {
			busy = false;
		}
	}

	async function runAction(actionId: string) {
		const action = ctx.toolbarActions.get(actionId);
		if (!action) return;
		try {
			await action.run(project, session, selectedItems);
		} catch (failure) {
			ctx.toasts.push(failure instanceof Error ? failure.message : String(failure), 'error');
		}
	}

	function isTypingTarget(target: EventTarget | null): boolean {
		return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
	}

	function onKeydown(event: KeyboardEvent) {
		if (batchOpen || isTypingTarget(event.target)) return;
		const action = gridActionForKey(event, selectedIds.size > 0);
		if (!action) return;
		event.preventDefault();
		if (action.kind === 'assign') batchOpen = true;
		if (action.kind === 'skip') void skipSelected();
		if (action.kind === 'delete') void deleteSelected();
		if (action.kind === 'clear') clearSelection();
	}
</script>

<svelte:window onkeydown={onKeydown} />

<div class="flex h-full flex-col">
	<div class="border-line flex flex-wrap items-center gap-3 border-b px-5 py-2 text-xs">
		<label class="text-dim flex items-center gap-2">
			<input type="checkbox" bind:checked={hideFinished} onchange={load} /> Hide finished
		</label>
		<div class="text-dim flex items-center gap-2">
			Sort
			<div class="w-44">
				<Select
					value={sort}
					onChange={(value) => {
						sort = value as GridSort;
						void load();
					}}
					options={[
						{ value: 'natural', label: 'Natural' },
						{ value: 'uncertainty', label: 'Most uncertain' }
					]}
				/>
			</div>
		</div>
		{#if textSearchSupported}
			<input
				class="input input-sm w-56"
				placeholder="Search by text…"
				bind:value={searchQuery}
				onkeydown={(event) => event.key === 'Enter' && load()}
			/>
		{/if}
		<button type="button" class="btn btn-xs btn-ghost" onclick={selectDuplicates} disabled={busy} title="Select near-duplicates so they can be skipped or bulk-labeled">
			Find duplicates
		</button>
		{#if duplicateMessage && selectedIds.size === 0}<span class="text-faint">{duplicateMessage}</span>{/if}

		{#if selectedIds.size > 0}
			<div class="ml-auto flex items-center gap-2">
				<span class="text-default font-semibold">{selectedIds.size} selected</span>
				<button type="button" class="btn btn-xs btn-primary" onclick={() => (batchOpen = true)} disabled={busy}>Assign tags <Key label="L" /></button>
				<button type="button" class="btn btn-xs btn-ghost" onclick={skipSelected} disabled={busy}>Skip <Key label="⇧S" /></button>
				<button type="button" class="btn btn-xs btn-ghost text-error" onclick={deleteSelected} disabled={busy}>Delete <Key label="⇧D" /></button>
				{#each applicableActions as action (action.id)}
					<button type="button" class="btn btn-xs btn-ghost" onclick={() => runAction(action.id)}>
						{#if action.icon}<action.icon size={13} />{/if}
						{action.label}
					</button>
				{/each}
				<button type="button" class="btn btn-xs btn-ghost" onclick={clearSelection}>Clear <Key label="Esc" /></button>
			</div>
		{:else}
			<span class="text-faint ml-auto hidden sm:inline">Click to label · shift-click selects a range · ctrl-click toggles</span>
		{/if}
	</div>

	{#if error}<div class="alert alert-error m-4 text-sm">{error}</div>{/if}

	<div class="min-h-0 flex-1 overflow-y-auto p-5">
		{#if loading}
			<div class="text-dim flex justify-center py-16"><span class="loading"></span></div>
		{:else if items.length === 0}
			<div class="text-dim py-16 text-center text-sm">Nothing here.</div>
		{:else}
			<MediaGrid {items} {session} {selectedIds} minimumCellWidth={140} {onSelect}>
				{#snippet overlay(item)}
					{@const tags = tagsOf(item)}
					{#if tags.length > 0}
						<div class="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap gap-1 bg-gradient-to-t from-black/80 to-transparent p-1.5 pt-6">
							{#each tags as tag (tag)}
								<span class="rounded bg-white/20 px-1.5 py-0.5 text-xs font-semibold text-white">{tag}</span>
							{/each}
						</div>
					{/if}
				{/snippet}
			</MediaGrid>
		{/if}
	</div>
</div>

{#if batchOpen}
	<BatchTagDialog
		groups={project.config.labels.groups}
		items={selectedItems}
		{busy}
		onApply={applyBatch}
		onCancel={() => (batchOpen = false)}
	/>
{/if}
