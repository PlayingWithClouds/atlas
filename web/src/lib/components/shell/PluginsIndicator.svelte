<script lang="ts">
	import { plugins } from '$lib/stores/plugins';
	import { connected } from '$lib/stores/live';
	import { theme } from '$lib/stores/theme';
	import SunIcon from 'phosphor-svelte/lib/Sun';
	import MoonIcon from 'phosphor-svelte/lib/Moon';
	import NotificationsBell from './NotificationsBell.svelte';

	let open = $state(false);
	const healthy = $derived($plugins.filter((p) => p.healthy).length);
	const total = $derived($plugins.length);
	const allOk = $derived($connected && total > 0 && healthy === total);
</script>

<div class="border-line relative border-t px-3 py-2">
	<div class="flex items-center gap-2">
		<button
			type="button"
			onclick={() => (open = !open)}
			class="hover:bg-hover text-dim flex flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs"
			title="Plugins"
		>
			<span class="inline-block h-2 w-2 rounded-full {allOk ? 'bg-green' : total ? 'bg-amber' : 'bg-red'}"></span>
			<span class="flex-1">{healthy}/{total} plugins</span>
		</button>
		<NotificationsBell />
		<button
			type="button"
			onclick={() => theme.update((t) => (t === 'dark' ? 'light' : 'dark'))}
			class="hover:bg-hover text-dim hover:text-default rounded-md p-1"
			title="Toggle theme"
		>
			{#if $theme === 'dark'}<SunIcon size={14} />{:else}<MoonIcon size={14} />{/if}
		</button>
	</div>

	{#if open}
		<button type="button" class="fixed inset-0 z-10 cursor-default" aria-label="Close" onclick={() => (open = false)}></button>
		<div class="border-line bg-surface absolute inset-x-3 bottom-full z-20 mb-1 overflow-hidden rounded-lg border p-2 shadow-lg">
			{#each $plugins as p (p.id)}
				<div class="flex items-start gap-2 px-2 py-1.5 text-xs">
					<span class="mt-1 inline-block h-2 w-2 shrink-0 rounded-full {p.healthy ? 'bg-green' : 'bg-red'}"></span>
					<div class="min-w-0 flex-1">
						<div class="text-default font-medium">{p.id}</div>
						<div class="text-faint truncate">{(p.capabilities ?? []).map((c) => c.name).join(', ') || p.error || '—'}</div>
					</div>
				</div>
			{:else}
				<div class="text-dim px-2 py-2 text-xs">No plugins connected</div>
			{/each}
		</div>
	{/if}
</div>
