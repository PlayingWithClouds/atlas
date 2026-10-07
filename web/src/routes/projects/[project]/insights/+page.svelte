<script lang="ts">
	import { page } from '$app/stores';
	import { getStats, type Stats } from '$lib/api/stats';
	import { exportDataset, importDataset } from '$lib/api/dataset';
	import { activeJobs, jobs, refreshJobs } from '$lib/stores/jobs';
	import { sessions } from '$lib/stores/sessions';
	import DownloadSimpleIcon from 'phosphor-svelte/lib/DownloadSimpleIcon';
	import UploadSimpleIcon from 'phosphor-svelte/lib/UploadSimpleIcon';

	let datasetDir = $state('');
	const exportJob = $derived($activeJobs.find((j) => j.type === 'export'));
	const importJob = $derived($activeJobs.find((j) => j.type === 'import'));

	async function runExport() {
		try {
			const res = await exportDataset();
			datasetDir = res.dir;
			refreshJobs();
		} catch {
			// ignore
		}
	}

	async function runImport() {
		try {
			const res = await importDataset();
			datasetDir = res.dir;
			refreshJobs();
		} catch {
			// ignore
		}
	}

	let stats = $state<Stats | null>(null);
	let loading = $state(true);

	async function refreshStats() {
		try {
			stats = await getStats($page.params.project ?? 'nsfw-tags');
		} catch {
			// backend down; keep last
		} finally {
			loading = false;
		}
	}

	// Library totals refetch whenever the WebSocket pushes a job update (also fires
	// once on mount). Sessions come straight from the store.
	$effect(() => {
		$jobs; // dependency: re-run on every live jobs push
		refreshStats();
	});

</script>

<div class="p-6">
	<div class="mb-5 flex items-center gap-3">
		<h1 class="text-default text-xl font-semibold tracking-tight">Stats</h1>
		{#if stats}<span class="text-faint text-xs font-mono">{stats.backbone}</span>{/if}
		<button type="button" class="btn btn-sm ml-auto" onclick={runImport} disabled={!!importJob || !!exportJob}>
			{#if importJob}<span class="loading loading-sm"></span> Importing {importJob.done}/{importJob.total}{:else}<UploadSimpleIcon size={15} /> Import + refit{/if}
		</button>
		<button type="button" class="btn btn-sm" onclick={runExport} disabled={!!exportJob || !!importJob}>
			{#if exportJob}<span class="loading loading-sm"></span> Exporting {exportJob.done}/{exportJob.total}{:else}<DownloadSimpleIcon size={15} /> Export dataset{/if}
		</button>
		<a href={`/projects/${$page.params.project}/insights/detail`} class="btn btn-sm btn-outline">Model insights →</a>
	</div>

	{#if importJob}
		<div class="alert alert-info mb-4 text-xs">
			Importing + embedding with the current backbone → refit ({importJob.done}/{importJob.total})…
		</div>
	{:else if exportJob}
		<div class="alert alert-info mb-4 text-xs">
			Exporting labeled images → <span class="font-mono">{exportJob.extra?.dir ?? datasetDir}</span> ({exportJob.done}/{exportJob.total})
		</div>
	{:else if datasetDir}
		<div class="alert alert-info mb-4 text-xs">
			Dataset dir: <span class="font-mono">{datasetDir}</span> (images + labels.json).
		</div>
	{/if}

	{#if loading && !stats}
		<div class="text-dim flex justify-center py-16"><span class="loading"></span></div>
	{:else if stats}
		<!-- Library -->
		<div class="mb-6 grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
			{#each [['In library', stats.labeled, 'confirmed labels'], ['Model pool', stats.pool, 'training examples'], ['Images', stats.images, 'across all sources'], ['Sessions', stats.sessions, 'sources touched']] as [label, value, sub] (label)}
				<div class="border-line bg-surface rounded-lg border p-4">
					<div class="text-default font-mono text-2xl">{value}</div>
					<div class="text-default text-xs font-medium">{label}</div>
					<div class="text-faint text-[11px]">{sub}</div>
				</div>
			{/each}
		</div>

		<!-- Per-source table -->
		<div class="border-line overflow-hidden rounded-lg border">
			<table class="w-full text-sm">
				<thead class="bg-elevated text-dim text-left text-xs">
					<tr>
						<th class="p-3 font-medium">Source</th>
						<th class="p-3 font-medium">Kind</th>
						<th class="p-3 font-medium">Labeled</th>
						<th class="p-3 font-medium">Total</th>
						<th class="p-3 font-medium">Status</th>
					</tr>
				</thead>
				<tbody>
					{#each $sessions as s (s.id)}
						<tr class="border-line border-t">
							<td class="p-3"><a href={`/projects/${$page.params.project}/session/${s.id}`} class="text-default hover:underline">{s.label}</a></td>
							<td class="text-dim p-3">{s.source}</td>
							<td class="p-3 font-mono">{s.labeled}</td>
							<td class="p-3 font-mono">{s.total}</td>
							<td class="p-3">
								{#if s.producing}<span class="text-amber text-xs">extracting</span>
								{:else if s.done}<span class="text-green text-xs">done</span>
								{:else}<span class="text-dim text-xs">in progress</span>{/if}
							</td>
						</tr>
					{:else}
						<tr><td class="text-dim p-6 text-center" colspan="6">No sessions yet.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
