<script lang="ts">
	import type { Project } from '@atlas/contracts';
	import { kernelContext } from '../../kernel/context';
	import PageHeader from '../shared/PageHeader.svelte';
	import DatabaseIcon from 'phosphor-svelte/lib/Database';
	import PlusIcon from 'phosphor-svelte/lib/Plus';

	let { project }: { project: Project } = $props();

	interface ProjectStats {
		sessions: number;
		items: number;
		labeled: number;
		skipped: number;
		poolSize: number;
		activeJobs: number;
	}

	const ctx = kernelContext();
	let stats = $state<ProjectStats | null>(null);

	const projectSessions = $derived(ctx.live.sessions.filter((session) => session.projectId === project.id));
	const openSessions = $derived(projectSessions.filter((session) => session.total - session.labeled - session.skipped > 0 || session.producing));
	const sessionIds = $derived(new Set(projectSessions.map((session) => session.id)));
	const runningJobs = $derived(
		ctx.live.jobs.filter((job) => job.state === 'running' && job.sessionId !== undefined && sessionIds.has(job.sessionId))
	);
	const widgets = $derived(ctx.overviewWidgets.list());

	const tiles = $derived([
		{ label: 'Labeled', value: stats ? stats.labeled : 0, hint: 'confirmed' },
		{ label: 'Skipped', value: stats ? stats.skipped : 0, hint: 'set aside' },
		{ label: 'Model pool', value: stats ? stats.poolSize : 0, hint: 'training examples' },
		{ label: 'Items', value: stats ? stats.items : 0, hint: `across ${stats ? stats.sessions : 0} sessions` }
	]);

	// Refetch whenever the live jobs slice changes (also runs once on mount).
	$effect(() => {
		void ctx.live.jobs;
		void ctx.live.sessions;
		ctx.api.get<ProjectStats>(`/projects/${project.id}/stats`).then(
			(loaded) => (stats = loaded),
			() => {}
		);
	});

	function jobLabel(type: string): string {
		const renderer = ctx.jobRenderers.list().find((candidate) => candidate.jobType === type);
		if (renderer) return renderer.label;
		return type;
	}
</script>

<div class="p-6">
	<PageHeader title="Overview" subtitle={`${project.config.mediaKind} · model ${project.config.model}`}>
		{#snippet actions()}
			{#if runningJobs.length}
				<span class="text-green flex items-center gap-1.5 text-xs">
					<span class="bg-green inline-block h-2 w-2 animate-pulse rounded-full"></span>
					{runningJobs.length} running
				</span>
			{/if}
			<a href={`/projects/${project.id}/data`} class="btn btn-sm btn-primary"><DatabaseIcon size={15} /> Add data</a>
		{/snippet}
	</PageHeader>

	<div class="mb-6 grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
		{#each tiles as tile (tile.label)}
			<div class="border-line bg-surface rounded-lg border p-4">
				<div class="text-default font-mono text-2xl">{tile.value}</div>
				<div class="text-default text-xs font-medium">{tile.label}</div>
				<div class="text-faint text-[11px]">{tile.hint}</div>
			</div>
		{/each}
	</div>

	<div class="grid gap-6 md:grid-cols-2">
		<div>
			<h2 class="text-dim mb-2 text-[11px] font-semibold tracking-wider uppercase">Open sessions</h2>
			<div class="border-line divide-line divide-y overflow-hidden rounded-lg border">
				{#each openSessions as session (session.id)}
					<a href={`/projects/${project.id}/session/${session.id}`} class="hover:bg-hover flex items-center gap-2 px-3 py-2 text-sm">
						<span class="text-default flex-1 truncate">{session.label}</span>
						<span class="text-faint text-xs">{session.labeled}/{session.total}</span>
						{#if session.producing}<span class="loading loading-xs"></span>{/if}
					</a>
				{:else}
					<a href={`/projects/${project.id}/data`} class="text-dim hover:text-default flex items-center gap-2 px-3 py-3 text-sm">
						<PlusIcon size={14} /> Open a source to start labeling
					</a>
				{/each}
			</div>
		</div>

		<div>
			<h2 class="text-dim mb-2 text-[11px] font-semibold tracking-wider uppercase">Running jobs</h2>
			<div class="border-line divide-line divide-y overflow-hidden rounded-lg border">
				{#each runningJobs as job (job.id)}
					<div class="flex items-center gap-2 px-3 py-2 text-sm">
						<span class="text-default flex-1">{jobLabel(job.type)}</span>
						<span class="text-faint text-xs">{job.phase}</span>
						<span class="text-faint font-mono text-xs">{job.done}/{job.total}</span>
					</div>
				{:else}
					<div class="text-dim px-3 py-3 text-sm">Nothing running</div>
				{/each}
			</div>
		</div>
	</div>

	{#each widgets as widget (widget.id)}
		<div class="mt-6"><widget.component {project} /></div>
	{/each}
</div>
