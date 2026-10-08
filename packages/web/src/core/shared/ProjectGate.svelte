<script lang="ts">
	// Resolves the `:project` route param against the live project list and renders
	// children once the project is known.
	import type { Project } from '@atlas/contracts';
	import type { Snippet } from 'svelte';
	import { kernelContext } from '../../kernel/context';
	import EmptyState from '../../lib/components/EmptyState.svelte';

	let { params, children }: { params: Record<string, string>; children: Snippet<[Project]> } = $props();

	const ctx = kernelContext();
	const project = $derived(ctx.live.projects.find((candidate) => candidate.id === params.project));
</script>

{#if project}
	{@render children(project)}
{:else if !ctx.live.loaded}
	<div class="text-dim flex justify-center py-16"><span class="loading"></span></div>
{:else}
	<div class="p-6">
		<EmptyState title="Project not found" hint={`There is no project "${params.project}".`}>
			<a href="/projects" class="btn btn-sm btn-primary">All projects</a>
		</EmptyState>
	</div>
{/if}
