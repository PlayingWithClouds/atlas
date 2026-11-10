<script lang="ts">
	import { kernelContext } from '../../../kernel/context';
	import { theme } from '../../../kernel/theme.svelte';
	import SunIcon from 'phosphor-svelte/lib/Sun';
	import MoonIcon from 'phosphor-svelte/lib/Moon';

	const ctx = kernelContext();
</script>

<div class="border-line flex items-center gap-2 border-t px-3 py-2">
	<span class="text-dim flex flex-1 items-center gap-2 px-1.5 text-xs" title="Live updates from the server">
		<span class="inline-block h-2 w-2 rounded-full {ctx.live.connected ? 'bg-green' : 'bg-red'}"></span>
		{#if ctx.live.connected}Live{:else}Reconnecting…{/if}
	</span>
	<button type="button" onclick={() => theme.toggle()} class="hover:bg-hover text-dim hover:text-default rounded-md p-1" title="Toggle theme">
		{#if theme.value === 'dark'}<SunIcon size={14} />{:else}<MoonIcon size={14} />{/if}
	</button>
</div>
