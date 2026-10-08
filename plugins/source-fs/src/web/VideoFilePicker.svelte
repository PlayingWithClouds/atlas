<script lang="ts">
	import type { Project } from '@atlas/contracts';
	import { EmptyState } from '@atlas/web/components';
	import { kernelContext } from '@atlas/web/kernel';
	import { onMount } from 'svelte';
	import { formatDuration, videoListingPath } from './videoListing';

	interface ListedVideo {
		id: string;
		title: string;
		meta?: { duration?: number; dir?: string };
	}

	let { open }: { project: Project; open: (params: Record<string, unknown>) => Promise<void> } = $props();

	const ctx = kernelContext();

	let videos = $state<ListedVideo[]>([]);
	let search = $state('');
	let loading = $state(false);
	let openingId = $state('');
	let error = $state('');

	onMount(() => void load());

	async function load() {
		loading = true;
		error = '';
		try {
			const listing = await ctx.api.get<{ items: ListedVideo[] }>(videoListingPath(search));
			videos = listing.items;
		} catch (failure) {
			error = failure instanceof Error ? failure.message : String(failure);
		} finally {
			loading = false;
		}
	}

	async function openVideo(video: ListedVideo) {
		openingId = video.id;
		error = '';
		try {
			await open({ path: video.id });
		} catch (failure) {
			error = failure instanceof Error ? failure.message : String(failure);
			openingId = '';
		}
	}
</script>

{#if error}<div class="alert alert-error mb-4 text-sm">{error}</div>{/if}

<div class="mb-4 flex max-w-xl items-center gap-2">
	<input
		class="input flex-1"
		placeholder="Filter by name, or paste a folder path…"
		spellcheck="false"
		bind:value={search}
		onkeydown={(event) => event.key === 'Enter' && load()}
	/>
	<button type="button" class="btn" onclick={load} disabled={loading}>Search</button>
</div>

{#if loading}
	<div class="text-dim flex justify-center py-16"><span class="loading"></span></div>
{:else if videos.length === 0}
	<EmptyState title="No videos found" hint="Paste a folder path into the search box to list its videos." />
{:else}
	<div class="border-line divide-line max-w-3xl divide-y overflow-hidden rounded-lg border">
		{#each videos as video (video.id)}
			<button
				type="button"
				class="hover:bg-hover flex w-full items-center gap-3 px-3 py-2 text-left text-sm"
				disabled={openingId !== ''}
				onclick={() => openVideo(video)}
			>
				<span class="text-default min-w-0 flex-1 truncate">{video.title}</span>
				{#if video.meta?.duration !== undefined}
					<span class="text-faint shrink-0 font-mono text-xs">{formatDuration(video.meta.duration)}</span>
				{/if}
				{#if openingId === video.id}<span class="loading loading-xs"></span>{/if}
			</button>
		{/each}
	</div>
{/if}
