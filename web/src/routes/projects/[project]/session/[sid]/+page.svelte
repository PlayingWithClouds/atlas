<script lang="ts">
	import { onMount } from 'svelte';
	import { activeProject } from '$lib/stores/projects';
	import { sessionOpened, sessionClosed } from '$lib/api/sessions';
	import SessionGrid from '$lib/session/SessionGrid.svelte';
	import ClipGrid from '$lib/session/ClipGrid.svelte';
	import RegionWorkspace from '$lib/session/RegionWorkspace.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Pick the annotator by the project's enabled primitives.
	const isRegion = $derived(($activeProject?.config.primitives ?? ['tag']).some((p) => p !== 'tag'));
	// Then by what it labels. The session status is authoritative (it survives a hard
	// refresh straight onto this URL); the project store is the fallback.
	const contentKind = $derived(data.status.content_kind ?? $activeProject?.config.contentKind ?? 'image');

	// Fire session_opened / session_closed workflow triggers on enter/leave.
	onMount(() => {
		sessionOpened(data.sid).catch(() => {});
		return () => {
			sessionClosed(data.sid).catch(() => {});
		};
	});
</script>

{#if isRegion}
	<RegionWorkspace sid={data.sid} />
{:else if contentKind === 'video'}
	<ClipGrid sid={data.sid} status={data.status} />
{:else}
	<SessionGrid sid={data.sid} status={data.status} />
{/if}
