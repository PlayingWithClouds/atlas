<script lang="ts">
	import { kernelContext } from '../../../kernel/context';
	import { theme } from '../../../kernel/theme.svelte';
	import SunIcon from 'phosphor-svelte/lib/Sun';
	import MoonIcon from 'phosphor-svelte/lib/Moon';
	import NotificationsBell from './NotificationsBell.svelte';

	const ctx = kernelContext();
	let open = $state(false);

	const healthy = $derived(ctx.live.plugins.filter((plugin) => plugin.state === 'ACTIVE').length);
	const total = $derived(ctx.live.plugins.length);
	const allOk = $derived(ctx.live.connected && total > 0 && healthy === total);

	function indicatorColor(): string {
		if (allOk) return 'bg-green';
		if (ctx.live.connected) return 'bg-amber';
		return 'bg-red';
	}
</script>

<div class="border-line relative border-t px-3 py-2">
	<div class="flex items-center gap-2">
		<button
			type="button"
			onclick={() => (open = !open)}
			class="hover:bg-hover text-dim flex flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs"
			title="Plugins"
		>
			<span class="inline-block h-2 w-2 rounded-full {indicatorColor()}"></span>
			<span class="flex-1">{healthy}/{total} plugins</span>
		</button>
		<NotificationsBell />
		<button
			type="button"
			onclick={() => theme.toggle()}
			class="hover:bg-hover text-dim hover:text-default rounded-md p-1"
			title="Toggle theme"
		>
			{#if theme.value === 'dark'}<SunIcon size={14} />{:else}<MoonIcon size={14} />{/if}
		</button>
	</div>

	{#if open}
		<button type="button" class="fixed inset-0 z-10 cursor-default" aria-label="Close" onclick={() => (open = false)}></button>
		<div class="border-line bg-surface absolute inset-x-3 bottom-full z-20 mb-1 max-h-96 overflow-y-auto rounded-lg border p-2 shadow-lg">
			{#each ctx.live.plugins as plugin (plugin.name)}
				<div class="flex items-start gap-2 px-2 py-1.5 text-xs">
					<span class="mt-1 inline-block h-2 w-2 shrink-0 rounded-full {plugin.state === 'ACTIVE' ? 'bg-green' : 'bg-red'}"></span>
					<div class="min-w-0 flex-1">
						<div class="text-default font-medium">{plugin.name}</div>
						<div class="text-faint truncate">{plugin.error || plugin.state}</div>
					</div>
				</div>
			{:else}
				<div class="text-dim px-2 py-2 text-xs">No plugins loaded</div>
			{/each}
		</div>
	{/if}
</div>
