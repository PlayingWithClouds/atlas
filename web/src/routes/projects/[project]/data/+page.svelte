<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { listSourceKinds, listSourceItems, openSource, type SourceKind, type SourceItem } from '$lib/api/sources';
	import { deleteSession } from '$lib/api/sessions';
	import { sessions as sessionsStore, refreshSessions } from '$lib/stores/sessions';
	import { veilImg } from '$lib/api/client';
	import { formatTime } from '$lib/session/clip';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';
	import ShuffleIcon from 'phosphor-svelte/lib/Shuffle';
	import TrashIcon from 'phosphor-svelte/lib/Trash';

	const project = $derived($page.params.project ?? 'nsfw-tags');

	let kinds = $state<SourceKind[]>([]);
	let activeKind = $state<SourceKind | null>(null);
	let items = $state<SourceItem[]>([]);
	let search = $state('');
	let loading = $state(false);
	let opening = $state<string | null>(null);
	let dirPath = $state('');
	let error = $state('');

	onMount(async () => {
		try {
			kinds = (await listSourceKinds()).kinds;
			activeKind = kinds.find((k) => k.browsable && k.layout === 'grid') ?? kinds[0] ?? null;
			if (activeKind) loadItems();
		} catch (e) {
			error = String(e);
		}
	});

	async function selectKind(kind: SourceKind) {
		activeKind = kind;
		items = [];
		error = '';
		if (kind.layout === 'grid' && !kind.sample) loadItems();
	}

	async function loadItems() {
		if (!activeKind || activeKind.layout !== 'grid' || activeKind.sample) return;
		loading = true;
		error = '';
		try {
			items = (await listSourceItems(activeKind.id, { search })).items;
		} catch (e) {
			error = String(e);
		} finally {
			loading = false;
		}
	}

	async function open(kind: string, id: string | null, key: string) {
		opening = key;
		error = '';
		try {
			const session = await openSource(kind, id, project);
			goto(`/projects/${project}/session/${session.id}`);
		} catch (e) {
			error = String(e);
			opening = null;
		}
	}

	function thumb(item: SourceItem): string | null {
		if (!item.thumbnail) return null;
		return item.thumbnail.startsWith('http') ? veilImg(item.thumbnail) : item.thumbnail;
	}

	// --- opened sources ------------------------------------------------------
	// Everything this project has open, so a session can be reopened or removed. Removing
	// drops its entities and labels, so the trash button asks once before it fires.
	const projectSessions = $derived($sessionsStore.filter((s) => (s.project ?? 'nsfw-tags') === project));

	let confirmingRemoval = $state<string | null>(null);
	let removing = $state<string | null>(null);

	async function removeSession(sid: string) {
		removing = sid;
		error = '';
		try {
			await deleteSession(sid);
			await refreshSessions();
		} catch (e) {
			error = String(e);
		} finally {
			removing = null;
			confirmingRemoval = null;
		}
	}
</script>

<div class="p-6">
	<h1 class="text-default mb-4 text-xl font-semibold tracking-tight">Data</h1>

	<div class="border-line mb-4 flex items-center gap-1 border-b">
		{#each kinds as kind (kind.plugin + kind.id)}
			<button
				type="button"
				onclick={() => selectKind(kind)}
				class="-mb-px border-b-2 px-3 py-2 text-sm transition-colors {activeKind?.id === kind.id
					? 'border-primary text-default font-medium'
					: 'text-dim hover:text-default border-transparent'}"
			>
				{kind.label}
			</button>
		{/each}
	</div>

	{#if error}
		<div class="alert alert-error mb-4 text-sm">{error}</div>
	{/if}

	{#if activeKind}
		{#if activeKind.sample}
			<!-- random-style sample source -->
			<div class="border-line bg-surface flex max-w-md flex-col items-start gap-3 rounded-lg border p-5">
				<p class="text-dim text-sm">{activeKind.hint ?? 'Open a diverse random sample to label.'}</p>
				<button type="button" class="btn btn-primary btn-sm" disabled={opening === 'sample'} onclick={() => open(activeKind!.id, null, 'sample')}>
					{#if opening === 'sample'}<span class="loading loading-sm"></span>{:else}<ShuffleIcon size={15} />{/if}
					Start random sample
				</button>
			</div>
		{:else if activeKind.layout === 'form'}
			<!-- directory-style path input -->
			<div class="border-line bg-surface flex max-w-lg flex-col gap-3 rounded-lg border p-5">
				<label class="text-dim text-sm" for="dirpath">{activeKind.hint ?? 'Path'}</label>
				<div class="flex gap-2">
					<input id="dirpath" class="input flex-1" bind:value={dirPath} placeholder="/path/to/images" spellcheck="false" />
					<button type="button" class="btn btn-primary" disabled={!dirPath.trim() || opening === 'dir'} onclick={() => open(activeKind!.id, dirPath.trim(), 'dir')}>
						{#if opening === 'dir'}<span class="loading loading-sm"></span>{:else}Open{/if}
					</button>
				</div>
			</div>
		{:else}
			<!-- browsable grid -->
			<div class="mb-4 flex items-center gap-2">
				<div class="border-line focus-within:border-line-strong flex max-w-xs flex-1 items-center gap-2 rounded-md border px-2.5 py-1.5">
					<MagnifyingGlassIcon size={14} class="text-dim" />
					<input
						class="text-default flex-1 bg-transparent text-sm outline-none"
						placeholder={activeKind.input === 'path'
							? 'Folder path, or filter by name…'
							: `Search ${activeKind.label.toLowerCase()}…`}
						bind:value={search}
						onkeydown={(e) => e.key === 'Enter' && loadItems()}
					/>
				</div>
			</div>

			{#if loading}
				<div class="text-dim flex justify-center py-16"><span class="loading"></span></div>
			{:else if !items.length}
				<div class="text-dim py-16 text-center text-sm">
					No {activeKind.itemNoun ?? 'item'}s found.
					{#if activeKind.input === 'path' && activeKind.hint}
						<span class="text-faint block text-xs">{activeKind.hint}</span>
					{/if}
				</div>
			{:else}
				<div class="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
					{#each items as item (item.id)}
						<button
							type="button"
							onclick={() => open(activeKind!.id, item.id, item.id)}
							class="border-line bg-surface hover:border-line-strong group flex flex-col overflow-hidden rounded-lg border text-left transition"
						>
							<div class="bg-base-100 relative aspect-[4/3] overflow-hidden">
								{#if thumb(item)}
									<img src={thumb(item)} alt="" class="h-full w-full object-cover transition group-hover:opacity-90" loading="lazy" />
								{/if}
								{#if opening === item.id}
									<div class="absolute inset-0 flex items-center justify-center bg-black/50"><span class="loading"></span></div>
								{/if}
							</div>
							<div class="flex items-center gap-2 p-2">
								<span class="text-default flex-1 truncate text-xs font-medium">{item.title}</span>
								{#if item.count != null}<span class="text-faint text-[10px]">{item.count}</span>{/if}
								{#if item.duration}<span class="text-faint font-mono text-[10px]">{formatTime(item.duration)}</span>{/if}
							</div>
						</button>
					{/each}
				</div>
			{/if}
		{/if}
	{/if}

	{#if projectSessions.length}
		<h2 class="text-dim mt-8 mb-2 text-[11px] font-semibold tracking-wider uppercase">Opened sources</h2>
		<div class="border-line divide-line max-w-2xl overflow-hidden rounded-lg border divide-y">
			{#each projectSessions as session (session.id)}
				<div class="flex items-center gap-3 px-3 py-2 text-sm">
					<a href={`/projects/${project}/session/${session.id}`} class="text-default hover:text-primary min-w-0 flex-1 truncate">
						{session.label}
					</a>
					<span class="text-faint shrink-0 text-xs">{session.labeled}/{session.total}</span>
					{#if session.producing}<span class="loading loading-xs shrink-0"></span>{/if}

					{#if confirmingRemoval === session.id}
						<span class="text-dim shrink-0 text-xs">Remove {session.total} items?</span>
						<button
							type="button"
							class="btn btn-xs btn-ghost text-error shrink-0"
							disabled={removing === session.id}
							onclick={() => removeSession(session.id)}
						>
							{removing === session.id ? 'Removing…' : 'Remove'}
						</button>
						<button type="button" class="btn btn-xs btn-ghost shrink-0" onclick={() => (confirmingRemoval = null)}>Cancel</button>
					{:else}
						<button
							type="button"
							class="btn btn-xs btn-ghost shrink-0"
							title="Remove this source and everything labeled in it"
							onclick={() => (confirmingRemoval = session.id)}
						>
							<TrashIcon size={14} />
						</button>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
