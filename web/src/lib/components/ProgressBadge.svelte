<script lang="ts">
	import type { Progress } from '$lib/api/types';

	let { progress }: { progress?: Progress } = $props();
</script>

{#if progress && progress.started}
	{#if progress.done}
		<span class="badge badge-sm badge-success">done</span>
	{:else}
		<span class="badge badge-sm">{progress.labeled}/{progress.total}</span>
	{/if}
{/if}
