<script lang="ts" module>
	// Remembered across image navigations (module scope survives remounts) so `c`
	// can reapply the previous image's tags on a streaky set.
	let lastSelection: string[] = [];
</script>

<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { getNext, getItem, imageUrl, postLabel, postSkip, deleteImage } from '$lib/api/label';
	import TagGrid from '$lib/components/TagGrid.svelte';
	import Key from '$lib/components/Key.svelte';
	import RunWorkflow from '$lib/session/RunWorkflow.svelte';
	import { metaFor, categoryIcon } from '$lib/labels';
	import type { NextImage, SessionStatus } from '$lib/api/types';

	let { sid, imageId, status }: { sid: string; imageId: number; status: SessionStatus } = $props();

	const project = $derived($page.params.project ?? 'nsfw-tags');

	let current = $state<NextImage | null>(null);
	let selected = $state<Set<string>>(new Set());
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let searchEl = $state<HTMLInputElement | null>(null);
	let query = $state('');

	const topSuggestions = $derived(
		Object.entries(current?.suggestions ?? {})
			.sort((a, b) => b[1] - a[1])
			.filter(([, prob]) => prob >= (current?.threshold ?? 0.5) * 0.5)
			.slice(0, 8)
	);

	const searchResults = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return [];
		return status.classes
			.filter((c) => c.toLowerCase().includes(q))
			.sort((a, b) => (current?.suggestions?.[b] ?? 0) - (current?.suggestions?.[a] ?? 0))
			.slice(0, 9);
	});

	function applyDefaults(image: NextImage) {
		const picks = new Set<string>();
		if (image.existing && image.existing.length) {
			image.existing.forEach((tag) => picks.add(tag));
		} else if (image.suggestions) {
			const threshold = image.threshold ?? 0.5;
			for (const [name, prob] of Object.entries(image.suggestions)) {
				if (prob >= threshold) picks.add(name);
			}
		}
		selected = picks;
	}

	// Load the image whenever the route's imageId changes.
	$effect(() => {
		const id = imageId;
		loading = true;
		error = '';
		getItem(sid, id)
			.then((image) => {
				current = { ...image, id };
				applyDefaults(current);
			})
			.catch((err) => (error = (err as Error).message))
			.finally(() => {
				loading = false;
				queueMicrotask(() => searchEl?.focus());
			});
	});

	function toGrid() {
		goto(`/projects/${project}/session/${sid}`);
	}

	// After an action, jump to the next pending image (active-learning order) or
	// back to the grid when the session is done.
	async function advance() {
		try {
			const next = await getNext(sid);
			if (next.done || next.id === undefined) toGrid();
			else goto(`/projects/${project}/session/${sid}/${next.id}`);
		} catch (err) {
			error = (err as Error).message;
		}
	}

	function toggle(name: string) {
		const next = new Set(selected);
		if (next.has(name)) next.delete(name);
		else next.add(name);
		selected = next;
	}

	function copyLast() {
		if (lastSelection.length) selected = new Set(lastSelection);
	}

	// Sets keep insertion order, so the last element is the most recently added tag.
	function removeLastTag() {
		const tags = [...selected];
		if (!tags.length) return;
		const next = new Set(tags);
		next.delete(tags[tags.length - 1]);
		selected = next;
	}

	async function save() {
		if (saving) return;
		saving = true;
		try {
			await postLabel(sid, imageId, [...selected]);
			lastSelection = [...selected];
			await advance();
		} catch (err) {
			error = (err as Error).message;
		} finally {
			saving = false;
		}
	}

	async function skip() {
		if (saving) return;
		saving = true;
		try {
			await postSkip(sid, imageId);
			await advance();
		} finally {
			saving = false;
		}
	}

	async function deleteCurrent() {
		if (saving) return;
		saving = true;
		try {
			await deleteImage(sid, imageId);
			await advance();
		} finally {
			saving = false;
		}
	}

	function pickSearch(name: string) {
		toggle(name);
		query = '';
		queueMicrotask(() => searchEl?.focus());
	}

	function onSearchKey(event: KeyboardEvent) {
		if (event.key >= '1' && event.key <= '9') {
			const item = searchResults[Number(event.key) - 1];
			if (item) {
				event.preventDefault();
				pickSearch(item);
			}
		} else if (event.key === 'Enter') {
			event.preventDefault();
			if (event.shiftKey) save();
			else if (searchResults.length) pickSearch(searchResults[0]);
			else save();
		} else if (event.key === 'Escape') {
			if (query) query = '';
			else toGrid();
		} else if (event.key === 'Backspace' && !query) {
			event.preventDefault();
			removeLastTag();
		} else if (!query && event.shiftKey && (event.key === 'S' || event.key === 'D' || event.key === 'C')) {
			// The search box is auto-focused, so shifted single-letter actions reach it.
			event.preventDefault();
			if (event.key === 'S') skip();
			else if (event.key === 'D') deleteCurrent();
			else copyLast();
		}
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
		if (event.key >= '1' && event.key <= '9') {
			const name = status.classes[Number(event.key) - 1];
			if (name) {
				event.preventDefault();
				toggle(name);
			}
		} else if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			save();
		} else if (event.key === 'S' && event.shiftKey) {
			event.preventDefault();
			skip();
		} else if (event.key === 'D' && event.shiftKey) {
			event.preventDefault();
			deleteCurrent();
		} else if (event.key === 'C' && event.shiftKey) {
			event.preventDefault();
			copyLast();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			toGrid();
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

<div class="flex h-full flex-col">
	<header class="border-line bg-elevated flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-5 py-3">
		<div class="min-w-0">
			<div class="text-default truncate text-sm font-semibold">{status.label}</div>
			<div class="text-dim text-xs">
				{status.labeled} labeled · {status.embedded}/{status.total} embedded
				{#if status.head_trained}· <span class="text-green">model live</span>{:else}· model warming up{/if}
			</div>
		</div>
		<div class="ml-auto flex items-center gap-2">
			<RunWorkflow {sid} />
			<button type="button" onclick={toGrid} class="btn btn-sm btn-ghost">← All <Key label="Esc" /></button>
		</div>
	</header>

	{#if error}<div class="alert alert-error m-4">{error}</div>{/if}

	<div class="flex min-h-0 flex-1">
		{#if loading && !current}
			<div class="text-dim flex flex-1 items-center justify-center"><span class="loading"></span></div>
		{:else if current}
			<div class="bg-base-100 flex min-w-0 flex-1 flex-col">
				<div class="border-line flex items-center gap-2 overflow-x-auto border-b px-4 py-3">
					{#each [...selected] as tag (tag)}
						{@const prob = current.suggestions?.[tag]}
						{@const img = categoryIcon(tag)}
						<button
							type="button"
							onclick={() => toggle(tag)}
							title="Remove"
							class="border-primary ring-primary relative flex h-16 w-28 shrink-0 flex-col overflow-hidden rounded-lg border text-left ring-1"
						>
							{#if img}
								<img src={img} alt="" class="absolute inset-0 h-full w-full object-cover" />
								<div class="absolute inset-x-0 bottom-0 flex items-end justify-between gap-1 bg-gradient-to-t from-black/85 to-transparent p-1.5 pt-6">
									<span class="text-left text-[11px] leading-tight font-semibold break-words text-white">{tag}</span>
									{#if prob !== undefined}<span class="shrink-0 font-mono text-[10px] font-bold text-white/85">{Math.round(prob * 100)}%</span>{/if}
								</div>
							{:else}
								<div class="bg-primary text-primary-content flex h-full w-full flex-col items-center justify-center gap-0.5 px-2">
									<span class="text-xl leading-none">{metaFor(tag).icon}</span>
									<span class="text-[11px] font-medium">{tag}</span>
								</div>
							{/if}
						</button>
					{:else}
						<span class="text-faint text-sm">No tags selected</span>
					{/each}
				</div>
				<div class="flex min-h-0 flex-1 items-center justify-center p-4">
					<img src={imageUrl(sid, imageId, status.token)} alt="to label" class="max-h-full max-w-full rounded-lg object-contain" />
				</div>
			</div>
			<div class="border-line bg-elevated flex w-[46vw] max-w-[760px] min-w-[520px] shrink-0 flex-col border-l">
				<div class="border-line border-b p-3">
					<input
						bind:this={searchEl}
						bind:value={query}
						onkeydown={onSearchKey}
						placeholder="Search tags… (1–9 pick · ⇧↵ save)"
						spellcheck="false"
						autocomplete="off"
						class="input input-sm w-full"
					/>
					{#if searchResults.length}
						<div class="mt-2 flex flex-col gap-0.5">
							{#each searchResults as name, i (name)}
								{@const on = selected.has(name)}
								{@const prob = current.suggestions?.[name]}
								<button
									type="button"
									onclick={() => pickSearch(name)}
									class="flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm {on ? 'bg-primary text-primary-content' : 'hover:bg-hover text-default'}"
								>
									<span class="font-mono text-[11px] {on ? 'opacity-70' : 'text-faint'}">{i + 1}</span>
									<span class="flex-1">{name}</span>
									{#if prob !== undefined}<span class="font-mono text-[11px] {on ? 'opacity-70' : 'text-green'}">{Math.round(prob * 100)}%</span>{/if}
								</button>
							{/each}
						</div>
					{/if}
				</div>
				{#if topSuggestions.length}
					<div class="border-line border-b p-3">
						<div class="text-dim mb-1.5 text-[10px] font-semibold tracking-wider uppercase">Suggested</div>
						<div class="flex flex-wrap gap-1.5">
							{#each topSuggestions as [name, prob] (name)}
								{@const on = selected.has(name)}
								<button
									type="button"
									onclick={() => toggle(name)}
									class="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors {on
										? 'border-transparent bg-primary text-primary-content'
										: 'border-green/50 bg-green-soft text-default hover:bg-hover'}"
								>
									{name}
									<span class="font-mono {on ? 'opacity-70' : 'text-green'}">{Math.round(prob * 100)}%</span>
								</button>
							{/each}
						</div>
					</div>
				{/if}
				<div class="min-h-0 flex-1 overflow-y-auto p-4">
					<TagGrid
						classes={status.classes}
						{selected}
						suggestions={current.suggestions ?? {}}
						threshold={current.threshold ?? 0.5}
						onToggle={toggle}
					/>
				</div>
				<div class="border-line flex items-center gap-2 border-t p-3">
					<button type="button" onclick={skip} class="btn btn-sm btn-ghost" disabled={saving}>Skip <Key label="⇧S" /></button>
					<button type="button" onclick={deleteCurrent} class="btn btn-sm btn-ghost text-error" disabled={saving} title="Delete this image from the session">Delete <Key label="⇧D" /></button>
					{#if lastSelection.length}
						<button type="button" onclick={copyLast} class="btn btn-sm btn-ghost" disabled={saving} title="Reapply the previous image's tags">Copy last <Key label="⇧C" /></button>
					{/if}
					<button type="button" onclick={save} class="btn btn-sm btn-primary ml-auto" disabled={saving}>
						Save + next <Key label="↵" />
					</button>
				</div>
			</div>
		{/if}
	</div>
</div>
