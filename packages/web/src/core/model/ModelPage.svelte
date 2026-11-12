<script lang="ts">
	import type { Group, ModelGroupOverview, ModelLabelOverview, ModelOverview, Project, Taxonomy } from '@atlas/contracts';
	import { onMount, untrack } from 'svelte';
	import { kernelContext } from '../../kernel/context';
	import EmptyState from '../../lib/components/EmptyState.svelte';
	import { messageOf } from '../shared/errors';
	import PageHeader from '../shared/PageHeader.svelte';
	import { filterSearch } from '../queue/itemFilter';
	import { queuePath } from '../queue/itemLink';

	let { params }: { params: Record<string, string> } = $props();

	/** Fewer labeled examples than this: the model is mostly guessing for that label. */
	const FEW_EXAMPLES = 5;
	const RELOAD_DELAY_MS = 2000;

	const ctx = kernelContext();

	let overview = $state<ModelOverview | undefined>(undefined);
	let taxonomy = $state<Taxonomy | undefined>(undefined);
	let error = $state('');
	let reloadTimer: ReturnType<typeof setTimeout> | undefined;

	const projectId = $derived(params.project);

	interface GroupRow {
		group: Group;
		overview: ModelGroupOverview;
		labels: { name: string; counts: ModelLabelOverview }[];
	}

	/** Groups and their labels, the most unsure first. */
	const groupRows = $derived.by(() => {
		if (overview === undefined || taxonomy === undefined) return [];
		const rows: GroupRow[] = [];
		for (const groupOverview of overview.groups) {
			const group = taxonomy.groups.find((candidate) => candidate.id === groupOverview.group);
			if (group === undefined) continue;
			rows.push({ group, overview: groupOverview, labels: labelRows(group, groupOverview) });
		}
		return rows.sort((first, second) => second.overview.unsure - first.overview.unsure);
	});

	const widestUnsure = $derived.by(() => {
		let widest = 1;
		for (const row of groupRows) {
			for (const label of row.labels) widest = Math.max(widest, label.counts.unsure);
		}
		return widest;
	});

	const subtitle = $derived.by(() => {
		if (overview === undefined) return '';
		if (overview.source === undefined) return `${overview.pending} pending · no suggestions yet`;
		return `Source "${overview.source}" · ${overview.suggested} of ${overview.pending} pending items suggested · unsure = 25–75%`;
	});

	function labelRows(group: Group, groupOverview: ModelGroupOverview) {
		const rows = groupOverview.labels.map((counts) => ({ name: labelName(group, counts.label), counts }));
		return rows.sort((first, second) => second.counts.unsure - first.counts.unsure);
	}

	function labelName(group: Group, labelId: string): string {
		const label = group.labels.find((candidate) => candidate.id === labelId);
		if (label === undefined) return labelId;
		return label.name;
	}

	function unsureLink(reference: string): string {
		return queuePath(projectId) + filterSearch({ unsure: reference, sort: 'match' });
	}

	function likelyLink(reference: string): string {
		return queuePath(projectId) + filterSearch({ label: reference, sort: 'match' });
	}

	function barWidth(count: number): string {
		return `${Math.round((count / widestUnsure) * 100)}%`;
	}

	async function load() {
		try {
			const [loadedOverview, project] = await Promise.all([
				ctx.api.get<ModelOverview>(`/projects/${encodeURIComponent(projectId)}/model`),
				ctx.api.get<Project>(`/projects/${encodeURIComponent(projectId)}`)
			]);
			overview = loadedOverview;
			taxonomy = project.taxonomy;
			error = '';
		} catch (failure) {
			error = messageOf(failure);
		}
	}

	function scheduleReload() {
		clearTimeout(reloadTimer);
		reloadTimer = setTimeout(() => void load(), RELOAD_DELAY_MS);
	}

	$effect(() => {
		void projectId;
		untrack(() => void load());
	});

	onMount(() => {
		const unsubscribe = ctx.live.subscribe((signal) => {
			if (signal.type === 'projects' || signal.type === 'settings' || signal.type === 'connected') return;
			if (signal.projectId === projectId) scheduleReload();
		});
		return () => {
			unsubscribe();
			clearTimeout(reloadTimer);
		};
	});
</script>

<div class="p-6">
	<PageHeader title="Model" {subtitle} />

	{#if error}<div class="alert alert-error mb-3">{error}</div>{/if}

	{#if overview === undefined}
		<div class="text-dim flex justify-center py-16"><span class="loading"></span></div>
	{:else if overview.source === undefined}
		<EmptyState title="No model suggestions yet" hint="Once an adapter pushes suggestions with values, this page shows where it is unsure." />
	{:else}
		<div class="grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax(420px, 1fr))">
			{#each groupRows as row (row.group.id)}
				<section class="bg-surface border-line rounded-lg border">
					<header class="border-line flex items-center gap-2 border-b px-3 py-2">
						<h2 class="text-default text-sm font-semibold">{row.group.label}</h2>
						<a href={unsureLink(row.group.id)} class="text-amber ml-auto text-xs hover:underline" title="Pending items with any label of this group at 25–75%">
							{row.overview.unsure} unsure →
						</a>
					</header>
					<table class="w-full text-xs">
						<thead>
							<tr class="text-faint">
								<th class="px-3 py-1.5 text-left font-normal">Label</th>
								<th class="px-2 py-1.5 text-right font-normal" title="Labeled items with it">Labeled</th>
								<th class="px-2 py-1.5 text-right font-normal" title="Pending items the model gives it at least 50%">Likely</th>
								<th class="px-3 py-1.5 text-left font-normal" title="Pending items at 25–75%">Unsure</th>
							</tr>
						</thead>
						<tbody>
							{#each row.labels as label (label.counts.label)}
								{@const reference = `${row.group.id}.${label.counts.label}`}
								<tr class="border-line-faint border-t">
									<td class="text-default px-3 py-1.5">
										{label.name}
										{#if label.counts.labeled < FEW_EXAMPLES}
											<span class="text-amber ml-1" title="Fewer than {FEW_EXAMPLES} labeled examples: mostly guessing">few examples</span>
										{/if}
									</td>
									<td class="text-dim px-2 py-1.5 text-right font-mono">{label.counts.labeled}</td>
									<td class="px-2 py-1.5 text-right font-mono">
										<a href={likelyLink(reference)} class="text-muted hover:underline">{label.counts.likely}</a>
									</td>
									<td class="w-40 px-3 py-1.5">
										<a href={unsureLink(reference)} class="flex items-center gap-2 hover:underline">
											<span class="bg-line relative h-1.5 flex-1 overflow-hidden rounded-full">
												<span class="bg-amber absolute inset-y-0 left-0 rounded-full" style="width: {barWidth(label.counts.unsure)}"></span>
											</span>
											<span class="text-muted w-10 text-right font-mono">{label.counts.unsure}</span>
										</a>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</section>
			{/each}
		</div>
	{/if}
</div>
