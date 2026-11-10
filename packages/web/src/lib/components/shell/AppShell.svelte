<script lang="ts">
	import type { Snippet } from 'svelte';
	import NavRail from './NavRail.svelte';

	let { projectId, focus = false, children }: { projectId?: string; focus?: boolean; children: Snippet } = $props();
</script>

<div class="bg-canvas flex h-screen gap-2 overflow-hidden p-2">
	{#if projectId && !focus}
		<NavRail {projectId} />
	{/if}
	<div class="border-line-faint bg-elevated flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border">
		<main class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
			{@render children()}
		</main>
	</div>
</div>
