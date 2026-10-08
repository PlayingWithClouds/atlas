<script lang="ts">
	import type { Project } from '@atlas/contracts';
	import { kernelContext } from '../../kernel/context';

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
	const tiles = $derived(
		stats
			? [
					['Labeled', stats.labeled, 'confirmed labels'],
					['Model pool', stats.poolSize, 'training examples'],
					['Items', stats.items, 'across all sessions'],
					['Sessions', stats.sessions, 'sources opened']
				]
			: []
	);

	$effect(() => {
		void ctx.live.jobs;
		ctx.api.get<ProjectStats>(`/projects/${project.id}/stats`).then(
			(loaded) => (stats = loaded),
			() => {}
		);
	});
</script>

{#if !stats}
	<div class="text-dim flex justify-center py-16"><span class="loading"></span></div>
{:else}
	<div class="mb-6 grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
		{#each tiles as [label, value, hint] (label)}
			<div class="border-line bg-surface rounded-lg border p-4">
				<div class="text-default font-mono text-2xl">{value}</div>
				<div class="text-default text-xs font-medium">{label}</div>
				<div class="text-faint text-[11px]">{hint}</div>
			</div>
		{/each}
	</div>

	<div class="border-line overflow-hidden rounded-lg border">
		<table class="w-full text-sm">
			<thead class="bg-elevated text-dim text-left text-xs">
				<tr>
					<th class="p-3 font-medium">Source</th>
					<th class="p-3 font-medium">Labeled</th>
					<th class="p-3 font-medium">Skipped</th>
					<th class="p-3 font-medium">Total</th>
					<th class="p-3 font-medium">Status</th>
				</tr>
			</thead>
			<tbody>
				{#each projectSessions as session (session.id)}
					<tr class="border-line border-t">
						<td class="p-3"><a href={`/projects/${project.id}/session/${session.id}`} class="text-default hover:underline">{session.label}</a></td>
						<td class="p-3 font-mono">{session.labeled}</td>
						<td class="p-3 font-mono">{session.skipped}</td>
						<td class="p-3 font-mono">{session.total}</td>
						<td class="p-3">
							{#if session.producing}<span class="text-amber text-xs">producing</span>
							{:else}<span class="text-dim text-xs">ready</span>{/if}
						</td>
					</tr>
				{:else}
					<tr><td class="text-dim p-6 text-center" colspan="5">No sessions yet.</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}
