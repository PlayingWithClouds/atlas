<script lang="ts">
	import { page } from '$app/stores';
	import { sessions } from '$lib/stores/sessions';
	import { plugins } from '$lib/stores/plugins';
	import { jobs, activeJobs } from '$lib/stores/jobs';
	import { getStats, type Stats } from '$lib/api/stats';
	import DatabaseIcon from 'phosphor-svelte/lib/Database';
	import PlusIcon from 'phosphor-svelte/lib/Plus';

	const project = $derived($page.params.project ?? 'nsfw-tags');
	let stats = $state<Stats | null>(null);

	// refetch on every live jobs push (also fires on mount)
	$effect(() => {
		$jobs;
		getStats(project).then((s) => (stats = s)).catch(() => {});
	});

	const openSessions = $derived($sessions.filter((s) => !s.done && (s.project ?? 'nsfw-tags') === project));
	const tiles = $derived([
		['Labeled', stats?.labeled ?? 0, 'confirmed'],
		['Pool', stats?.pool ?? 0, 'training examples'],
		['Images', stats?.images ?? 0, 'across sources']
	] as [string, number, string][]);
</script>

<div class="p-6">
	<div class="mb-5 flex items-center gap-3">
		<h1 class="text-default text-xl font-semibold tracking-tight">Overview</h1>
		{#if $activeJobs.length}
			<span class="text-green flex items-center gap-1.5 text-xs">
				<span class="bg-green inline-block h-2 w-2 animate-pulse rounded-full"></span>
				{$activeJobs.length} running
			</span>
		{/if}
		<a href={`/projects/${project}/data`} class="btn btn-sm btn-primary ml-auto"><DatabaseIcon size={15} /> Add data</a>
	</div>

	<div class="mb-6 grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
		{#each tiles as [label, value, sub] (label)}
			<div class="border-line bg-surface rounded-lg border p-4">
				<div class="text-default font-mono text-2xl">{value}</div>
				<div class="text-default text-xs font-medium">{label}</div>
				<div class="text-faint text-[11px]">{sub}</div>
			</div>
		{/each}
	</div>

	<div class="grid gap-6 md:grid-cols-2">
		<div>
			<h2 class="text-dim mb-2 text-[11px] font-semibold tracking-wider uppercase">Open sessions</h2>
			<div class="border-line divide-line overflow-hidden rounded-lg border divide-y">
				{#each openSessions as s (s.id)}
					<a href={`/projects/${project}/session/${s.id}`} class="hover:bg-hover flex items-center gap-2 px-3 py-2 text-sm">
						<span class="text-default flex-1 truncate">{s.label}</span>
						<span class="text-faint text-xs">{s.labeled}/{s.total}</span>
						{#if s.producing}<span class="loading loading-xs"></span>{/if}
					</a>
				{:else}
					<a href={`/projects/${project}/data`} class="text-dim hover:text-default flex items-center gap-2 px-3 py-3 text-sm">
						<PlusIcon size={14} /> Open a source to start labeling
					</a>
				{/each}
			</div>
		</div>

		<div>
			<h2 class="text-dim mb-2 text-[11px] font-semibold tracking-wider uppercase">Plugins</h2>
			<div class="border-line divide-line overflow-hidden rounded-lg border divide-y">
				{#each $plugins as p (p.id)}
					<div class="flex items-center gap-2 px-3 py-2 text-sm">
						<span class="inline-block h-2 w-2 rounded-full {p.healthy ? 'bg-green' : 'bg-red'}"></span>
						<span class="text-default flex-1">{p.id}</span>
						<span class="text-faint text-xs">{(p.capabilities ?? []).map((c) => c.name).join(', ')}</span>
					</div>
				{:else}
					<div class="text-dim px-3 py-3 text-sm">No plugins connected</div>
				{/each}
			</div>
		</div>
	</div>
</div>
