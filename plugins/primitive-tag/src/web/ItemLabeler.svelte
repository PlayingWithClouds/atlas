<script lang="ts">
	import type { Item, Project, Session } from '@atlas/contracts';
	import { Key, TagGrid } from '@atlas/web/components';
	import { kernelContext } from '@atlas/web/kernel';
	import { onMount } from 'svelte';
	import TagSearch from './TagSearch.svelte';
	import { itemActionForKey } from './keyboardMap';
	import type { ItemAction } from './keyboardMap';
	import {
		announceSession,
		confirmAnnotations,
		deleteItem,
		describeItem,
		listItems,
		nextItem,
		skipItem
	} from './labelApi';
	import { annotationsWithTags, classNamesOfGroups, initialSelection, recallTags, rememberTags, tagsOf } from './itemTags';

	let { project, session, item }: { project: Project; session: Session; item: Item } = $props();

	const ctx = kernelContext();
	const DEFAULT_THRESHOLD = 0.5;
	const SUGGESTION_FLOOR_FACTOR = 0.5;
	const MAX_SUGGESTION_CHIPS = 8;

	let selected = $state<Set<string>>(new Set());
	let suggestions = $state<Record<string, number>>({});
	let threshold = $state(DEFAULT_THRESHOLD);
	let orderedIds = $state<string[]>([]);
	let saving = $state(false);
	let error = $state('');

	const groups = $derived(project.config.labels.groups);
	const classNames = $derived(classNamesOfGroups(groups));
	const cell = $derived(ctx.mediaCells.list().find((candidate) => candidate.mediaKind === item.mediaKind));
	const position = $derived(orderedIds.indexOf(item.id));
	const topSuggestions = $derived(
		Object.entries(suggestions)
			.filter(([, probability]) => probability >= threshold * SUGGESTION_FLOOR_FACTOR)
			.sort((left, right) => right[1] - left[1])
			.slice(0, MAX_SUGGESTION_CHIPS)
	);

	onMount(() => {
		void announceSession(ctx.api, session.id, 'opened');
		listItems(ctx.api, session.id, false, 'natural')
			.then((items) => (orderedIds = items.map((candidate) => candidate.id)))
			.catch(() => (orderedIds = []));
		return () => void announceSession(ctx.api, session.id, 'closed');
	});

	// Reload suggestions whenever the route hands us another item.
	$effect(() => {
		void loadDetail(item);
	});

	async function loadDetail(current: Item) {
		error = '';
		selected = new Set(tagsOf(current));
		suggestions = {};
		try {
			const detail = await describeItem(ctx.api, current.id);
			if (detail.item.id !== item.id) return;
			suggestions = detail.suggestions;
			threshold = detail.threshold;
			selected = initialSelection(tagsOf(detail.item), detail.suggestions, detail.threshold);
		} catch (failure) {
			failWith(failure);
		}
	}

	function failWith(failure: unknown) {
		error = failure instanceof Error ? failure.message : String(failure);
	}

	function itemUrl(itemId: string): string {
		return `/projects/${project.id}/session/${session.id}/${itemId}`;
	}

	function backToGrid() {
		ctx.router.navigate(`/projects/${project.id}/session/${session.id}`);
	}

	async function advance() {
		const next = await nextItem(ctx.api, session.id);
		if (next.done || next.waiting || !next.item) {
			backToGrid();
			return;
		}
		ctx.router.navigate(itemUrl(next.item.id));
	}

	function neighbour(offset: number) {
		const target = orderedIds[position + offset];
		if (target !== undefined) {
			ctx.router.navigate(itemUrl(target));
		}
	}

	function toggle(name: string) {
		const next = new Set(selected);
		if (next.has(name)) {
			next.delete(name);
		} else {
			next.add(name);
		}
		selected = next;
	}

	function reapplyLast() {
		const last = recallTags();
		if (last.length > 0) {
			selected = new Set(last);
		}
	}

	async function guarded(task: () => Promise<void>) {
		if (saving) return;
		saving = true;
		try {
			await task();
		} catch (failure) {
			failWith(failure);
		} finally {
			saving = false;
		}
	}

	function confirm() {
		return guarded(async () => {
			const labels = [...selected];
			await confirmAnnotations(ctx.api, item.id, annotationsWithTags(item, labels));
			rememberTags(labels);
			await advance();
		});
	}

	function skip() {
		return guarded(async () => {
			await skipItem(ctx.api, item.id);
			await advance();
		});
	}

	function remove() {
		return guarded(async () => {
			await deleteItem(ctx.api, item.id);
			await advance();
		});
	}

	function perform(action: ItemAction) {
		if (action.kind === 'toggleClass') toggle(action.name);
		if (action.kind === 'confirm') void confirm();
		if (action.kind === 'skip') void skip();
		if (action.kind === 'delete') void remove();
		if (action.kind === 'reapplyLast') reapplyLast();
		if (action.kind === 'previous') neighbour(-1);
		if (action.kind === 'next') neighbour(1);
		if (action.kind === 'close') backToGrid();
	}

	function handleKey(event: KeyboardEvent) {
		const action = itemActionForKey(event, classNames);
		if (!action) return;
		event.preventDefault();
		perform(action);
	}

	// Plain `s` must stay typeable in the search box; Shift+S still skips from there.
	function onSearchKey(event: KeyboardEvent) {
		if (event.key === 's') return;
		handleKey(event);
	}

	function onWindowKeydown(event: KeyboardEvent) {
		if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
		handleKey(event);
	}

	function onSubmit() {
		void confirm();
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="flex h-full flex-col">
	<header class="border-line bg-elevated flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-5 py-3">
		<div class="text-default min-w-0 truncate text-sm font-semibold">{session.label}</div>
		<span class="text-faint text-xs">{position >= 0 ? `${position + 1} / ${orderedIds.length}` : ''}</span>
		<div class="ml-auto flex items-center gap-2">
			<button type="button" class="btn btn-sm btn-ghost" onclick={() => neighbour(-1)} disabled={position <= 0}>← Prev</button>
			<button type="button" class="btn btn-sm btn-ghost" onclick={() => neighbour(1)} disabled={position < 0 || position >= orderedIds.length - 1}>Next →</button>
			<button type="button" class="btn btn-sm btn-ghost" onclick={backToGrid}>All <Key label="Esc" /></button>
		</div>
	</header>

	{#if error}<div class="alert alert-error m-4 text-sm">{error}</div>{/if}

	<div class="flex min-h-0 flex-1">
		<div class="bg-base-100 flex min-w-0 flex-1 flex-col">
			<div class="border-line flex items-center gap-2 overflow-x-auto border-b px-4 py-3">
				{#each [...selected] as tag (tag)}
					{@const probability = suggestions[tag]}
					<button type="button" onclick={() => toggle(tag)} title="Remove" class="bg-primary text-primary-content flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold">
						{tag}
						{#if probability !== undefined}<span class="font-mono opacity-70">{Math.round(probability * 100)}%</span>{/if}
					</button>
				{:else}
					<span class="text-faint text-sm">No tags selected</span>
				{/each}
			</div>
			<div class="flex min-h-0 flex-1 items-center justify-center p-4">
				{#key item.id}
					{#if cell}
						<cell.component {item} {session} active={true} />
					{:else}
						<img src={ctx.api.url(`/items/${item.id}/media`)} alt="" class="max-h-full max-w-full rounded-lg object-contain" />
					{/if}
				{/key}
			</div>
		</div>

		<div class="border-line bg-elevated flex w-[46vw] max-w-[760px] min-w-[420px] shrink-0 flex-col border-l">
			<div class="border-line border-b p-3">
				<TagSearch
					{classNames}
					{selected}
					{suggestions}
					placeholder="Search tags… (1–9 pick · ↵ save)"
					onPick={toggle}
					{onSubmit}
					onKey={onSearchKey}
				/>
			</div>

			{#if topSuggestions.length > 0}
				<div class="border-line border-b p-3">
					<div class="text-dim mb-1.5 text-[10px] font-semibold tracking-wider uppercase">Suggested</div>
					<div class="flex flex-wrap gap-1.5">
						{#each topSuggestions as [name, probability] (name)}
							{@const on = selected.has(name)}
							<button
								type="button"
								onclick={() => toggle(name)}
								class="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors {on
									? 'border-transparent bg-primary text-primary-content'
									: 'border-green/50 bg-green-soft text-default hover:bg-hover'}"
							>
								{name}
								<span class="font-mono {on ? 'opacity-70' : 'text-green'}">{Math.round(probability * 100)}%</span>
							</button>
						{/each}
					</div>
				</div>
			{/if}

			<div class="min-h-0 flex-1 overflow-y-auto p-4">
				<TagGrid {groups} {selected} {suggestions} {threshold} onToggle={toggle} />
			</div>

			<div class="border-line flex items-center gap-2 border-t p-3">
				<button type="button" onclick={skip} class="btn btn-sm btn-ghost" disabled={saving}>Skip <Key label="S" /></button>
				<button type="button" onclick={remove} class="btn btn-sm btn-ghost text-error" disabled={saving}>Delete <Key label="⇧D" /></button>
				<button type="button" onclick={reapplyLast} class="btn btn-sm btn-ghost" disabled={saving}>Reapply last <Key label="⇧C" /></button>
				<button type="button" onclick={confirm} class="btn btn-sm btn-primary ml-auto" disabled={saving}>Save + next <Key label="↵" /></button>
			</div>
		</div>
	</div>
</div>
