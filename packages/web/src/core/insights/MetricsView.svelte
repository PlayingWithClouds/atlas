<script lang="ts">
	import type { Project } from '@atlas/contracts';
	import { onMount } from 'svelte';
	import { kernelContext } from '../../kernel/context';
	import { messageOf } from '../shared/errors';

	let { project }: { project: Project } = $props();

	interface ClassMetrics {
		name: string;
		support: number;
		negatives: number;
		evaluated: boolean;
		averagePrecision?: number;
		f1?: number;
		precision?: number;
		recall?: number;
		threshold?: number;
	}

	const ctx = kernelContext();
	let data = $state<{ poolSize: number; classes: ClassMetrics[] } | null>(null);
	let loading = $state(false);
	let error = $state('');

	onMount(load);

	async function load() {
		loading = true;
		error = '';
		try {
			data = await ctx.api.get(`/projects/${project.id}/insights`);
		} catch (failure) {
			error = messageOf(failure);
		} finally {
			loading = false;
		}
	}

	function metricColor(value: number): string {
		if (value >= 0.8) return 'var(--ctx-green, #4ade80)';
		if (value >= 0.5) return 'var(--ctx-amber, #fbbf24)';
		return 'var(--ctx-red, #f87171)';
	}

	function display(value: number | undefined): string {
		if (value === undefined) return '—';
		return String(value);
	}
</script>

<div class="mb-2 flex items-center gap-3">
	<p class="text-dim max-w-3xl text-sm">
		Cross-validated performance of the model head per class. <span class="text-muted font-medium">Average precision</span>
		is the honest ranking metric for rare classes; low scores with little support are where more labels help most.
	</p>
	<button type="button" class="btn btn-sm ml-auto" onclick={load} disabled={loading}>Recompute</button>
</div>

{#if error}<div class="alert alert-error mb-4 text-sm">{error}</div>{/if}

{#if loading}
	<div class="text-dim flex flex-col items-center gap-2 py-16"><span class="loading"></span> Evaluating…</div>
{:else if data}
	<div class="text-dim mb-3 text-xs">
		Pool: <span class="text-default font-mono">{data.poolSize}</span> labeled ·
		{data.classes.filter((entry) => entry.evaluated).length} classes evaluated
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
				{#each data.classes as entry (entry.name)}
					<tr class="border-line border-t {entry.evaluated ? '' : 'opacity-50'}">
						<td class="p-3 font-medium">{entry.name}</td>
						<td class="p-3 font-mono">{entry.support}</td>
						<td class="p-3">
							{#if entry.evaluated && entry.averagePrecision !== undefined}
								<div class="flex items-center gap-2">
									<div class="bg-base-100 h-2 flex-1 overflow-hidden rounded-full">
										<div class="h-full rounded-full" style="width: {entry.averagePrecision * 100}%; background: {metricColor(entry.averagePrecision)}"></div>
									</div>
									<span class="w-10 text-right font-mono text-xs">{entry.averagePrecision}</span>
								</div>
							{:else}
								<span class="text-faint text-xs">too few examples</span>
							{/if}
						</td>
						<td class="p-3 font-mono">{entry.evaluated ? display(entry.f1) : '—'}</td>
						<td class="p-3 font-mono">{entry.evaluated ? display(entry.precision) : '—'}</td>
						<td class="p-3 font-mono">{entry.evaluated ? display(entry.recall) : '—'}</td>
						<td class="text-dim p-3 font-mono">{entry.evaluated ? display(entry.threshold) : '—'}</td>
					</tr>
				{:else}
					<tr><td class="text-dim p-6 text-center" colspan="7">This project has no classes yet.</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}
