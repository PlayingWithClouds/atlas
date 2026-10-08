<script lang="ts">
	import type { Project } from '@atlas/contracts';
	import { kernelContext } from '../../kernel/context';
	import EmptyState from '../../lib/components/EmptyState.svelte';
	import PageHeader from '../shared/PageHeader.svelte';

	let { project }: { project: Project } = $props();

	const ctx = kernelContext();
	let chosenId = $state('');

	const panes = $derived(ctx.settingsPanes.list());
	const activePane = $derived(panes.find((pane) => pane.id === chosenId) || panes[0]);
</script>

<div class="mx-auto max-w-3xl p-6">
	<PageHeader title="Settings" />

	{#if !panes.length}
		<EmptyState title="No settings panes" hint="Enable a plugin that contributes a settings pane." />
	{:else}
		<div class="border-line mb-5 flex items-center gap-1 border-b">
			{#each panes as pane (pane.id)}
				<button
					type="button"
					onclick={() => (chosenId = pane.id)}
					class="-mb-px border-b-2 px-3 py-2 text-sm transition-colors {activePane.id === pane.id
						? 'border-primary text-default font-medium'
						: 'text-dim hover:text-default border-transparent'}"
				>
					{pane.label}
				</button>
			{/each}
		</div>
		{#key activePane.id}
			<activePane.component {project} />
		{/key}
	{/if}
</div>
