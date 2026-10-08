<script lang="ts">
	// Fallback used when no source picker is registered for a source kind: lists browsable
	// kinds with search, or accepts raw JSON params for kinds that cannot be browsed.
	import { onMount } from 'svelte';
	import { kernelContext } from '../../kernel/context';
	import { messageOf } from '../shared/errors';
	import EmptyState from '../../lib/components/EmptyState.svelte';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';

	interface ListedItem {
		id: string;
		title: string;
		thumbnail?: string;
		meta?: Record<string, unknown>;
	}

	let {
		provider,
		kind,
		label,
		browsable,
		open
	}: {
		provider: string;
		kind: string;
		label: string;
		browsable: boolean;
		open: (params: Record<string, unknown>) => Promise<void>;
	} = $props();

	const PAGE_SIZE = 40;
	const ctx = kernelContext();

	let items = $state<ListedItem[]>([]);
	let search = $state('');
	let loading = $state(false);
	let openingId = $state<string | null>(null);
	let error = $state('');
	let rawParams = $state('{}');

	onMount(() => {
		if (browsable) void load();
	});

	async function load() {
		loading = true;
		error = '';
		try {
			const query = `search=${encodeURIComponent(search)}&limit=${PAGE_SIZE}&offset=0`;
			const listing = await ctx.api.get<{ items: ListedItem[] }>(
				`/sources/${encodeURIComponent(provider)}/${encodeURIComponent(kind)}/items?${query}`
			);
			items = listing.items;
		} catch (failure) {
			error = messageOf(failure);
		} finally {
			loading = false;
		}
	}

	async function openItem(item: ListedItem) {
		openingId = item.id;
		error = '';
		try {
			await open({ id: item.id });
		} catch (failure) {
			error = messageOf(failure);
			openingId = null;
		}
	}

	function parseRawParams(): Record<string, unknown> | undefined {
		try {
			const parsed = JSON.parse(rawParams);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed;
			}
		} catch {
			// reported below
		}
		error = 'Params must be a JSON object.';
		return undefined;
	}

	async function openRaw() {
		error = '';
		const params = parseRawParams();
		if (!params) return;
		openingId = 'raw';
		try {
			await open(params);
		} catch (failure) {
			error = messageOf(failure);
			openingId = null;
		}
	}
</script>

{#if error}<div class="alert alert-error mb-4 text-sm">{error}</div>{/if}

{#if browsable}
	<div class="mb-4 flex items-center gap-2">
		<div class="border-line focus-within:border-line-strong flex max-w-xs flex-1 items-center gap-2 rounded-md border px-2.5 py-1.5">
			<MagnifyingGlassIcon size={14} class="text-dim" />
			<input
				class="text-default flex-1 bg-transparent text-sm outline-none"
				placeholder={`Search ${label.toLowerCase()}…`}
				bind:value={search}
				onkeydown={(event) => event.key === 'Enter' && load()}
			/>
		</div>
	</div>

	{#if loading}
		<div class="text-dim flex justify-center py-16"><span class="loading"></span></div>
	{:else if !items.length}
		<div class="text-dim py-16 text-center text-sm">Nothing found.</div>
	{:else}
		<div class="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
			{#each items as item (item.id)}
				<button
					type="button"
					onclick={() => openItem(item)}
					class="border-line bg-surface hover:border-line-strong group flex flex-col overflow-hidden rounded-lg border text-left transition"
				>
					<div class="bg-base-100 relative aspect-[4/3] overflow-hidden">
						{#if item.thumbnail}
							<img src={item.thumbnail} alt="" class="h-full w-full object-cover transition group-hover:opacity-90" loading="lazy" />
						{/if}
						{#if openingId === item.id}
							<div class="absolute inset-0 flex items-center justify-center bg-black/50"><span class="loading"></span></div>
						{/if}
					</div>
					<div class="p-2"><span class="text-default block truncate text-xs font-medium">{item.title}</span></div>
				</button>
			{/each}
		</div>
	{/if}
{:else}
	<EmptyState title={`${label} is not browsable`} hint="No picker is registered for this source kind. Enter its parameters as JSON.">
		<textarea class="input h-24 w-full py-2 font-mono text-xs" spellcheck="false" bind:value={rawParams}></textarea>
		<button type="button" class="btn btn-sm btn-primary" disabled={openingId === 'raw'} onclick={openRaw}>Open</button>
	</EmptyState>
{/if}
