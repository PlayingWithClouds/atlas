<script lang="ts">
	import type { Project } from '@atlas/contracts';
	import { kernelContext } from '../../kernel/context';
	import EmptyState from '../../lib/components/EmptyState.svelte';
	import PageHeader from '../shared/PageHeader.svelte';

	let { project }: { project: Project } = $props();

	const ctx = kernelContext();
	let chosenId = $state('');

	const views = $derived(ctx.insightsViews.list());
	const activeView = $derived(views.find((view) => view.id === chosenId) || views[0]);
</script>

<div class="p-6">
	<PageHeader title="Insights" />

	{#if !views.length}
		<EmptyState title="No insight views" hint="Enable a plugin that contributes an insights view." />
	{:else}
		<div class="border-line mb-5 flex items-center gap-1 border-b">
			{#each views as view (view.id)}
				<button
					type="button"
					onclick={() => (chosenId = view.id)}
					class="-mb-px border-b-2 px-3 py-2 text-sm transition-colors {activeView.id === view.id
						? 'border-primary text-default font-medium'
						: 'text-dim hover:text-default border-transparent'}"
				>
					{view.label}
				</button>
			{/each}
		</div>
		{#key activeView.id}
			<activeView.component {project} />
		{/key}
	{/if}
</div>
