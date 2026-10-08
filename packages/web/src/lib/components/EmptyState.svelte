<script lang="ts">
	import type { Snippet } from 'svelte';

	let { title, hint, children }: { title: string; hint?: string; children?: Snippet } = $props();
</script>

<div class="border-line bg-surface flex max-w-xl flex-col items-start gap-2 rounded-lg border p-5">
	<div class="text-default text-sm font-medium">{title}</div>
	{#if hint}<p class="text-dim text-sm">{hint}</p>{/if}
	{@render children?.()}
</div>
