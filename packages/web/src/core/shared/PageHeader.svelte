<script lang="ts">
	import type { Snippet } from 'svelte';

	let { title, subtitle, actions }: { title: string; subtitle?: string; actions?: Snippet } = $props();
</script>

<div class="mb-5 flex items-start gap-3">
	<div>
		<h1 class="text-default text-xl font-semibold tracking-tight">{title}</h1>
		{#if subtitle}<p class="text-dim mt-1 text-sm">{subtitle}</p>{/if}
	</div>
	<div class="ml-auto flex items-center gap-2">
		{@render actions?.()}
	</div>
</div>
