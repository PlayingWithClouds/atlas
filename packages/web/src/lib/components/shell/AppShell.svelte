<script lang="ts">
	import type { Snippet } from 'svelte';
	import NavRail from './NavRail.svelte';

	let { projectId, focus = false, children }: { projectId?: string; focus?: boolean; children: Snippet } = $props();
</script>

<div class="bg-elevated flex h-screen overflow-hidden">
	{#if projectId && !focus}
		<NavRail {projectId} />
	{/if}
	<main class="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
		{@render children()}
	</main>
</div>
