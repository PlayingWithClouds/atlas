<script lang="ts">
	import { onMount } from 'svelte';
	import NavRail from './NavRail.svelte';
	import AssistantPane from '$lib/components/assistant/AssistantPane.svelte';
	import { loadAssistantConfig } from '$lib/stores/assistant';

	let { project, children }: { project: string; children: import('svelte').Snippet } = $props();

	onMount(loadAssistantConfig);
</script>

<div class="bg-canvas flex h-screen gap-2 overflow-hidden p-2">
	<NavRail {project} />
	<div class="border-line-faint bg-elevated flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border">
		<main class="flex-1 overflow-x-hidden overflow-y-auto">
			{@render children()}
		</main>
	</div>
	<AssistantPane />
</div>
