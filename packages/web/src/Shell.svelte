<script lang="ts">
	import '@fontsource-variable/geist';
	import './lib/design/app.css';
	import type { Context } from '@neoworks/extension-system';
	import { provideKernelContext } from './kernel/context';
	import { palette } from './kernel/palette.svelte';
	import { theme } from './kernel/theme.svelte';
	import AppShell from './lib/components/shell/AppShell.svelte';
	import CommandMenu from './lib/components/CommandMenu.svelte';
	import CommandPalette from './lib/components/CommandPalette.svelte';
	import EmptyState from './lib/components/EmptyState.svelte';
	import Toaster from './lib/components/Toaster.svelte';

	let { kernel }: { kernel: Context } = $props();

	// The kernel is created once in main.ts and never swapped.
	// svelte-ignore state_referenced_locally
	provideKernelContext(kernel);

	const current = $derived(kernel.router.current);
	const projectId = $derived(current ? current.params.project : undefined);

	$effect(() => {
		theme.apply();
	});

	function onKeydown(event: KeyboardEvent) {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
			event.preventDefault();
			palette.toggle();
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

<CommandPalette />
<AppShell {projectId}>
	{#if current}
		{#key kernel.router.path}
			<current.route.component params={current.params} />
		{/key}
	{:else}
		<div class="p-6">
			<EmptyState title="Page not found" hint={`Nothing is registered at ${kernel.router.path}.`}>
				<a href="/projects" class="btn btn-sm btn-primary">Go to projects</a>
			</EmptyState>
		</div>
	{/if}
</AppShell>
<CommandMenu />
<Toaster />
