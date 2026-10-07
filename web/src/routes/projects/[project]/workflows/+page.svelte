<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import {
		listWorkflows,
		getNodeCatalog,
		saveWorkflow,
		deleteWorkflow,
		runWorkflow,
		triggerLabel,
		type Workflow,
		type WorkflowGraph,
		type NodeSpec
	} from '$lib/api/workflows';
	import { sessions } from '$lib/stores/sessions';
	import { activeJobs } from '$lib/stores/jobs';
	import Designer from '$lib/components/workflow/Designer.svelte';
	import FlowArrowIcon from 'phosphor-svelte/lib/FlowArrow';
	import PlayIcon from 'phosphor-svelte/lib/Play';
	import PencilIcon from 'phosphor-svelte/lib/Pencil';
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import PlusIcon from 'phosphor-svelte/lib/Plus';

	const project = $derived($page.params.project ?? 'nsfw-tags');

	let workflows = $state<Workflow[]>([]);
	let catalog = $state<NodeSpec[]>([]);
	let palette = $state<NodeSpec[]>([]);
	let target = $state('');
	let error = $state('');

	// Edit state: null = list view, otherwise the workflow being designed.
	let editing = $state<{
		id: string;
		label: string;
		triggers: string[];
		graph: WorkflowGraph;
	} | null>(null);

	const openSessions = $derived($sessions.filter((s) => !s.done));

	onMount(load);

	async function load() {
		try {
			// Two catalogs: the full one so an existing graph renders every node it
			// holds, and the project's own so the palette only offers what it can run.
			const [wf, all, offered] = await Promise.all([
				listWorkflows($page.params.project),
				getNodeCatalog(),
				getNodeCatalog($page.params.project)
			]);
			workflows = wf.workflows;
			catalog = all.nodes;
			palette = offered.nodes;
		} catch (e) {
			error = String(e);
		}
	}

	$effect(() => {
		if (!target && openSessions.length) target = openSessions[0].id;
	});

	function slugify(label: string): string {
		const slug = label
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '');
		return slug || 'workflow';
	}

	function newWorkflow() {
		editing = {
			id: '',
			label: 'New workflow',
			triggers: [],
			graph: {
				nodes: [{ id: 'source-0', type: 'source', pos: { x: 80, y: 120 } }],
				edges: []
			}
		};
	}

	function edit(workflow: Workflow) {
		const graph = workflow.graph ?? { nodes: [], edges: [] };
		editing = {
			id: workflow.id,
			label: workflow.label,
			triggers: workflow.triggers ?? [],
			graph
		};
	}

	// Save and delete both answer with every workflow there is; the page only shows
	// the ones this project runs.
	function ownedHere(list: Workflow[]): Workflow[] {
		return list.filter((workflow) => !workflow.project || workflow.project === $page.params.project);
	}

	async function persist(label: string, triggers: string[], graph: WorkflowGraph) {
		error = '';
		const id = editing?.id || slugify(label);
		try {
			// Saving claims the workflow for this project: its graph is written against
			// this project's content kind and backbone.
			const result = await saveWorkflow({ id, label, project: $page.params.project, triggers, graph });
			workflows = ownedHere(result.workflows);
			editing = null;
		} catch (e) {
			error = String(e);
		}
	}

	async function remove(id: string) {
		error = '';
		try {
			const result = await deleteWorkflow(id);
			workflows = ownedHere(result.workflows);
		} catch (e) {
			error = String(e);
		}
	}

	async function run(id: string) {
		if (!target) return;
		error = '';
		try {
			await runWorkflow(target, id);
		} catch (e) {
			error = String(e);
		}
	}
</script>

{#if editing}
	<div class="fixed inset-0 z-40 flex flex-col bg-canvas">
		<Designer
			bind:label={editing.label}
			bind:triggers={editing.triggers}
			graph={editing.graph}
			{catalog}
			{palette}
			{project}
			onSave={persist}
			onClose={() => (editing = null)}
		/>
	</div>
{/if}

<div class="p-6">
	<div class="mb-5 flex items-start justify-between">
		<div>
			<h1 class="text-default mb-1 text-xl font-semibold tracking-tight">Workflows</h1>
			<p class="text-dim text-sm">Design a node graph, then run it over an open session.</p>
		</div>
		<button type="button" class="btn btn-sm btn-primary" onclick={newWorkflow}>
			<PlusIcon size={14} /> New workflow
		</button>
	</div>

	{#if error}<div class="alert alert-error mb-4 text-sm">{error}</div>{/if}

	<div class="mb-4 flex items-center gap-2">
		<span class="text-dim text-sm">Run on:</span>
		<select class="input input-sm max-w-xs" bind:value={target}>
			{#each openSessions as s (s.id)}<option value={s.id}>{s.label}</option>{/each}
		</select>
		{#if !openSessions.length}<span class="text-faint text-xs">Open a source first (Data)</span>{/if}
	</div>

	<div class="grid gap-3 sm:grid-cols-2">
		{#each workflows as wf (wf.id)}
			{@const running = $activeJobs.find((j) => j.type === 'workflow' && j.session_id === target)}
			{@const steps = (wf.graph?.nodes ?? []).map((n) => n.type)}
			{@const triggers = wf.triggers ?? []}
			{@const manual = triggers.length === 0 || triggers.includes('manual')}
			<div class="border-line bg-surface flex items-center gap-3 rounded-lg border p-4">
				<div class="bg-action/15 text-action flex h-9 w-9 items-center justify-center rounded-lg">
					<FlowArrowIcon size={18} />
				</div>
				<div class="min-w-0 flex-1">
					<div class="flex flex-wrap items-center gap-1.5">
						<span class="text-default text-sm font-semibold">{wf.label}</span>
						{#each triggers as trigger (trigger)}
							<span class="bg-raised text-dim rounded px-1.5 py-0.5 text-[10px]">
								{triggerLabel(trigger)}
							</span>
						{:else}
							<span class="bg-raised text-dim rounded px-1.5 py-0.5 text-[10px]">Manual</span>
						{/each}
					</div>
					<div class="text-faint truncate text-xs">{steps.join(' → ') || 'empty'}</div>
				</div>
				<button type="button" class="btn btn-sm btn-ghost" title="Edit" onclick={() => edit(wf)}>
					<PencilIcon size={14} />
				</button>
				<button type="button" class="btn btn-sm btn-ghost" title="Delete" onclick={() => remove(wf.id)}>
					<TrashIcon size={14} />
				</button>
				{#if manual}
					<button
						type="button"
						class="btn btn-sm btn-primary"
						disabled={!target || !!running}
						onclick={() => run(wf.id)}
					>
						{#if running}<span class="loading loading-sm"></span> {running.done}/{running.total}
						{:else}<PlayIcon size={14} /> Run{/if}
					</button>
				{/if}
			</div>
		{:else}
			<div class="text-dim text-sm">No workflows yet — create one.</div>
		{/each}
	</div>
</div>
