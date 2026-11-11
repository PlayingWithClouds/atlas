<script lang="ts">
	import { kernelContext } from '../../../kernel/context';
	import { palette } from '../../../kernel/palette.svelte';
	import ProjectSwitcher from './ProjectSwitcher.svelte';
	import StatusFooter from './StatusFooter.svelte';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';
	import CircleIcon from 'phosphor-svelte/lib/Circle';

	let { projectId }: { projectId: string } = $props();

	const ctx = kernelContext();

	function hrefOf(path: string): string {
		return `/projects/${encodeURIComponent(projectId)}/${path}`;
	}

	function isActive(path: string): boolean {
		return ctx.router.path.startsWith(hrefOf(path));
	}
</script>

<aside class="border-line-faint bg-canvas flex h-full w-60 shrink-0 flex-col border-r">
	<ProjectSwitcher {projectId} />

	<button
		type="button"
		onclick={() => palette.show()}
		class="border-line text-dim hover:text-default mx-3 mt-1 mb-2 flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs"
	>
		<MagnifyingGlassIcon size={13} />
		<span class="flex-1 text-left">Search…</span>
		<kbd class="border-line rounded border px-1 text-[10px]">⌘K</kbd>
	</button>

	<nav class="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
		{#each ctx.nav.list() as item (item.id)}
			<a
				href={hrefOf(item.path)}
				class="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors {isActive(item.path)
					? 'bg-hover text-default font-medium'
					: 'text-muted hover:text-default hover:bg-hover/50'}"
			>
				{#if item.icon}
					<item.icon size={16} />
				{:else}
					<CircleIcon size={16} />
				{/if}
				{item.label}
			</a>
		{/each}
	</nav>

	<StatusFooter />
</aside>
