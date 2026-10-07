<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { activeProject } from '$lib/stores/projects';
	import ImageLabeler from '$lib/session/ImageLabeler.svelte';
	import ClipLabeler from '$lib/session/ClipLabeler.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const project = $derived($page.params.project ?? 'nsfw-tags');

	// Region projects have no single-image page; send them back to the grid.
	const isRegion = $derived(($activeProject?.config.primitives ?? ['tag']).some((p) => p !== 'tag'));
	// A video project labels clips, which need a player rather than a still.
	const contentKind = $derived(data.status.content_kind ?? $activeProject?.config.contentKind ?? 'image');
	$effect(() => {
		if (isRegion) goto(`/projects/${project}/session/${data.sid}`);
	});
</script>

{#if isRegion}
	<!-- redirected above -->
{:else if contentKind === 'video'}
	<ClipLabeler sid={data.sid} imageId={data.imageId} status={data.status} />
{:else}
	<ImageLabeler sid={data.sid} imageId={data.imageId} status={data.status} />
{/if}
