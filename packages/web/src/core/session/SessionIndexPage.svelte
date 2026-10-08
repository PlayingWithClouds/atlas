<script lang="ts">
	// "Annotate" entry: jump into the only open session, otherwise offer a chooser.
	import type { Project } from '@atlas/contracts';
	import { kernelContext } from '../../kernel/context';
	import EmptyState from '../../lib/components/EmptyState.svelte';
	import PageHeader from '../shared/PageHeader.svelte';
	import DatabaseIcon from 'phosphor-svelte/lib/Database';

	let { project }: { project: Project } = $props();

	const ctx = kernelContext();

	const open = $derived(
		ctx.live.sessions.filter(
			(session) => session.projectId === project.id && (session.producing || session.total - session.labeled - session.skipped > 0)
		)
	);

	$effect(() => {
		if (open.length === 1) {
			ctx.router.navigate(`/projects/${project.id}/session/${open[0].id}`, { replace: true });
		}
	});
</script>

<div class="p-6">
	<PageHeader title="Annotate" />

	{#if open.length}
		<div class="border-line divide-line max-w-lg divide-y overflow-hidden rounded-lg border">
			{#each open as session (session.id)}
				<a href={`/projects/${project.id}/session/${session.id}`} class="hover:bg-hover flex items-center gap-2 px-4 py-3 text-sm">
					<span class="text-default flex-1 truncate">{session.label}</span>
					<span class="text-faint text-xs">{session.labeled}/{session.total}</span>
				</a>
			{/each}
		</div>
	{:else}
		<EmptyState title="No open sessions" hint="Add a data source to start annotating.">
			<a href={`/projects/${project.id}/data`} class="btn btn-sm btn-primary"><DatabaseIcon size={15} /> Go to Data</a>
		</EmptyState>
	{/if}
</div>
