<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { getInsights, type Insights } from '$lib/api/insights';
	import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';

	let data = $state<Insights | null>(null);
	let loading = $state(true);
	let error = $state('');

	async function load() {
		loading = true;
		error = '';
		try {
			data = await getInsights($page.params.project ?? 'nsfw-tags');
		} catch (err) {
			error = (err as Error).message;
		} finally {
			loading = false;
		}
	}

	function apColor(ap: number) {
		if (ap >= 0.6) return 'var(--ctx-green)';
		if (ap >= 0.3) return 'var(--ctx-amber)';
		return 'var(--ctx-red)';
	}

	onMount(load);
</script>

<div class="p-6">
	<div class="mb-2 flex items-center gap-3">
		<a href={`/projects/${$page.params.project}/insights`} class="btn btn-sm btn-ghost"><ArrowLeftIcon size={15} /> Insights</a>
		<h1 class="text-default text-xl font-semibold tracking-tight">Model insights</h1>
		<button type="button" class="btn btn-sm ml-auto" onclick={load} disabled={loading}>Recompute</button>
	</div>
	<p class="text-dim mb-5 max-w-3xl text-sm">
		5-fold cross-validated performance of the linear head per class, over the global pool.
		<span class="text-muted font-medium">Average precision</span> (PR-AUC) is the honest ranking metric
		for rare tags; <span class="text-muted font-medium">F1 / precision / recall</span> are at the best
		threshold. Low-scoring classes with little support are where more labels help most.
	</p>

	{#if error}<div class="alert alert-error mb-4">{error}</div>{/if}

	{#if loading}
		<div class="text-dim flex flex-col items-center gap-2 py-16">
			<span class="loading"></span> Cross-validating the pool…
		</div>
	{:else if data}
		<div class="text-dim mb-3 text-xs">
			Pool: <span class="text-default font-mono">{data.pool}</span> labeled ·
			backbone <span class="font-mono">{data.backbone}</span> ·
			{data.classes.filter((c) => c.evaluated).length} classes evaluated
		</div>
		<div class="border-line overflow-hidden rounded-lg border">
			<table class="w-full text-sm">
				<thead class="bg-elevated text-dim text-left text-xs">
					<tr>
						<th class="p-3 font-medium">Class</th>
						<th class="p-3 font-medium">Support</th>
						<th class="w-64 p-3 font-medium">Avg precision</th>
						<th class="p-3 font-medium">F1</th>
						<th class="p-3 font-medium">Precision</th>
						<th class="p-3 font-medium">Recall</th>
						<th class="p-3 font-medium">Thresh</th>
					</tr>
				</thead>
				<tbody>
					{#each data.classes as c (c.name)}
						<tr class="border-line border-t {c.evaluated ? '' : 'opacity-50'}">
							<td class="p-3 font-medium">{c.name}</td>
							<td class="p-3 font-mono">{c.support}</td>
							<td class="p-3">
								{#if c.evaluated}
									<div class="flex items-center gap-2">
										<div class="bg-base-100 h-2 flex-1 overflow-hidden rounded-full">
											<div class="h-full rounded-full" style="width: {(c.average_precision ?? 0) * 100}%; background: {apColor(c.average_precision ?? 0)}"></div>
										</div>
										<span class="w-10 text-right font-mono text-xs">{c.average_precision}</span>
									</div>
								{:else}
									<span class="text-faint text-xs">too few examples</span>
								{/if}
							</td>
							<td class="p-3 font-mono">{c.evaluated ? c.f1 : '—'}</td>
							<td class="p-3 font-mono">{c.evaluated ? c.precision : '—'}</td>
							<td class="p-3 font-mono">{c.evaluated ? c.recall : '—'}</td>
							<td class="text-dim p-3 font-mono">{c.evaluated ? c.threshold : '—'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
