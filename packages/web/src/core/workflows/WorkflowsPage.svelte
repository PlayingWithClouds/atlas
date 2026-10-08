<script lang="ts">
	import type { NodeSpec, Project, TriggerSpec, Workflow, WorkflowGraph } from '@atlas/contracts';
	import { onMount } from 'svelte';
	import { kernelContext } from '../../kernel/context';
	import { messageOf } from '../shared/errors';
	import { listFrom } from '../shared/lists';
	import PageHeader from '../shared/PageHeader.svelte';
	import Designer from './Designer.svelte';
	import FlowArrowIcon from 'phosphor-svelte/lib/FlowArrow';
	import PlayIcon from 'phosphor-svelte/lib/Play';
	import PencilIcon from 'phosphor-svelte/lib/Pencil';
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import PlusIcon from 'phosphor-svelte/lib/Plus';

	let { project }: { project: Project } = $props();

	interface EditingWorkflow {
		id: string;
		label: string;
		triggers: string[];
		graph: WorkflowGraph;
	}

	const ctx = kernelContext();
	const projectQuery = $derived(`projectId=${encodeURIComponent(project.id)}`);

	let workflows = $state<Workflow[]>([]);
	let catalog = $state<NodeSpec[]>([]);
	let palette = $state<NodeSpec[]>([]);
	let triggerOptions = $state<TriggerSpec[]>([]);
	let target = $state('');
	let error = $state('');
	let editing = $state<EditingWorkflow | null>(null);

	const openSessions = $derived(ctx.live.sessions.filter((session) => session.projectId === project.id));

	onMount(load);

	$effect(() => {
		if (!target && openSessions.length) target = openSessions[0].id;
	});

	async function load() {
		try {
			// Full catalog so an existing graph renders every node it holds; the project's
			// own catalog so the palette only offers what it can run.
			const [loadedWorkflows, allNodes, projectNodes, loadedTriggers] = await Promise.all([
				ctx.api.get(`/workflows?${projectQuery}`),
				ctx.api.get('/workflows/nodes'),
				ctx.api.get(`/workflows/nodes?${projectQuery}`),
				ctx.api.get('/workflows/triggers')
			]);
			workflows = listFrom<Workflow>(loadedWorkflows, 'workflows');
			catalog = listFrom<NodeSpec>(allNodes, 'nodes');
			palette = listFrom<NodeSpec>(projectNodes, 'nodes');
			triggerOptions = listFrom<TriggerSpec>(loadedTriggers, 'triggers');
		} catch (failure) {
			error = messageOf(failure);
		}
	}

	async function reloadWorkflows() {
		workflows = listFrom<Workflow>(await ctx.api.get(`/workflows?${projectQuery}`), 'workflows');
	}

	function slugify(label: string): string {
		const slug = label
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '');
		return slug || 'workflow';
	}

	function triggerLabel(triggerId: string): string {
		const found = triggerOptions.find((trigger) => trigger.id === triggerId);
		if (found) return found.label;
		return triggerId;
	}

	function newWorkflow() {
		editing = { id: '', label: 'New workflow', triggers: [], graph: { nodes: [], edges: [] } };
	}

	function edit(workflow: Workflow) {
		editing = { id: workflow.id, label: workflow.label, triggers: workflow.triggers, graph: workflow.graph };
	}

	async function persist(label: string, triggers: string[], graph: WorkflowGraph) {
		error = '';
		const id = editing && editing.id ? editing.id : slugify(label);
		try {
			await ctx.api.post('/workflows', { id, label, projectId: project.id, triggers, graph });
			await reloadWorkflows();
			editing = null;
		} catch (failure) {
			error = messageOf(failure);
		}
	}

	async function remove(id: string) {
		error = '';
		try {
			await ctx.api.delete(`/workflows/${id}`);
			await reloadWorkflows();
		} catch (failure) {
			error = messageOf(failure);
		}
	}

	async function run(id: string) {
		if (!target) return;
		error = '';
		try {
			await ctx.api.post(`/sessions/${target}/workflow/${id}`, {});
		} catch (failure) {
			error = messageOf(failure);
		}
	}

	function runningJobOn(sessionId: string) {
		return ctx.live.jobs.find((job) => job.type === 'workflow' && job.state === 'running' && job.sessionId === sessionId);
	}

	function isManual(workflow: Workflow): boolean {
		return workflow.triggers.length === 0 || workflow.triggers.includes('manual');
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
			{triggerOptions}
			projectId={project.id}
			onSave={persist}
			onClose={() => (editing = null)}
		/>
	</div>
{/if}

<div class="p-6">
	<PageHeader title="Workflows" subtitle="Design a node graph, then run it over an open session.">
		{#snippet actions()}
			<button type="button" class="btn btn-sm btn-primary" onclick={newWorkflow}><PlusIcon size={14} /> New workflow</button>
		{/snippet}
	</PageHeader>

	{#if error}<div class="alert alert-error mb-4 text-sm">{error}</div>{/if}

	<div class="mb-4 flex items-center gap-2">
		<span class="text-dim text-sm">Run on:</span>
		<select class="input input-sm max-w-xs" bind:value={target}>
			{#each openSessions as session (session.id)}<option value={session.id}>{session.label}</option>{/each}
		</select>
		{#if !openSessions.length}<span class="text-faint text-xs">Open a source first (Data)</span>{/if}
	</div>

	<div class="grid gap-3 sm:grid-cols-2">
		{#each workflows as workflow (workflow.id)}
			{@const running = runningJobOn(target)}
			<div class="border-line bg-surface flex items-center gap-3 rounded-lg border p-4">
				<div class="bg-action/15 text-action flex h-9 w-9 items-center justify-center rounded-lg">
					<FlowArrowIcon size={18} />
				</div>
				<div class="min-w-0 flex-1">
					<div class="flex flex-wrap items-center gap-1.5">
						<span class="text-default text-sm font-semibold">{workflow.label}</span>
						{#each workflow.triggers as trigger (trigger)}
							<span class="bg-raised text-dim rounded px-1.5 py-0.5 text-[10px]">{triggerLabel(trigger)}</span>
						{:else}
							<span class="bg-raised text-dim rounded px-1.5 py-0.5 text-[10px]">Manual</span>
						{/each}
					</div>
					<div class="text-faint truncate text-xs">{workflow.graph.nodes.map((node) => node.type).join(' → ') || 'empty'}</div>
				</div>
				<button type="button" class="btn btn-sm btn-ghost" title="Edit" onclick={() => edit(workflow)}><PencilIcon size={14} /></button>
				<button type="button" class="btn btn-sm btn-ghost" title="Delete" onclick={() => remove(workflow.id)}><TrashIcon size={14} /></button>
				{#if isManual(workflow)}
					<button type="button" class="btn btn-sm btn-primary" disabled={!target || !!running} onclick={() => run(workflow.id)}>
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
