<script lang="ts">
	import { classNamesOf } from '@atlas/contracts';
	import type { Project, ProjectConfig } from '@atlas/contracts';
	import type { ProjectTemplateContribution } from '@atlas/contracts/web';
	import { onMount } from 'svelte';
	import { kernelContext } from '../../kernel/context';
	import { messageOf } from '../shared/errors';
	import { listFrom } from '../shared/lists';
	import EmptyState from '../../lib/components/EmptyState.svelte';
	import PlusIcon from 'phosphor-svelte/lib/Plus';

	// Route components receive `params`; the list page has none.
	let _routeProps: { params: Record<string, string> } = $props();

	const ctx = kernelContext();

	let creating = $state(false);
	let name = $state('');
	let mediaKind = $state('');
	let model = $state('');
	let primitives = $state('');
	let busy = $state(false);
	let error = $state('');
	let activeTemplateId = $state('');

	// Suggestions only: the server may not expose these listings yet, so failures are silent.
	let knownMediaKinds = $state<string[]>([]);
	let knownModels = $state<string[]>([]);
	let knownPrimitives = $state<string[]>([]);

	const templates = $derived(ctx.projectTemplates.list());
	const canCreate = $derived(name.trim() !== '' && mediaKind.trim() !== '' && model.trim() !== '' && !busy);

	onMount(async () => {
		knownMediaKinds = await idsFrom('/media-kinds', 'mediaKinds');
		knownModels = await idsFrom('/models', 'models');
		knownPrimitives = await idsFrom('/primitives', 'primitives');
	});

	async function idsFrom(path: string, key: string): Promise<string[]> {
		try {
			const entries = listFrom<{ id: string }>(await ctx.api.get(path), key);
			return entries.map((entry) => entry.id);
		} catch {
			return [];
		}
	}

	function applyTemplate(template: ProjectTemplateContribution) {
		activeTemplateId = template.id;
		const config = template.config;
		if (config.mediaKind) mediaKind = config.mediaKind;
		if (config.model) model = config.model;
		if (config.primitives) primitives = config.primitives.join(', ');
	}

	function parsePrimitives(): string[] {
		return primitives
			.split(',')
			.map((entry) => entry.trim())
			.filter((entry) => entry !== '');
	}

	function buildConfig(): ProjectConfig {
		const template = ctx.projectTemplates.get(activeTemplateId);
		const base: Partial<ProjectConfig> = template ? template.config : {};
		return {
			labels: { groups: [] },
			...base,
			primitives: parsePrimitives(),
			mediaKind: mediaKind.trim(),
			model: model.trim()
		};
	}

	async function create() {
		if (!canCreate) return;
		busy = true;
		error = '';
		try {
			const project = await ctx.api.post<Project>('/projects', { name: name.trim(), config: buildConfig() });
			ctx.router.navigate(`/projects/${project.id}/overview`);
		} catch (failure) {
			error = messageOf(failure);
		} finally {
			busy = false;
		}
	}

	function openProject(id: string) {
		ctx.router.navigate(`/projects/${id}/overview`);
	}
</script>

<div class="mx-auto max-w-2xl p-8">
	<h1 class="text-default mb-1 text-2xl font-semibold tracking-tight">Projects</h1>
	<p class="text-dim mb-6 text-sm">A project bundles a label schema, its data, and its own model pool.</p>

	{#if ctx.live.projects.length}
		<div class="border-line divide-line mb-4 divide-y overflow-hidden rounded-lg border">
			{#each ctx.live.projects as project (project.id)}
				<button type="button" onclick={() => openProject(project.id)} class="hover:bg-hover flex w-full items-center gap-3 px-4 py-3 text-left">
					<div class="bg-primary/15 text-primary flex h-8 w-8 items-center justify-center rounded font-bold">{project.name.slice(0, 1).toUpperCase()}</div>
					<div class="flex-1">
						<div class="text-default text-sm font-medium">{project.name}</div>
						<div class="text-faint text-xs">
							{classNamesOf(project.config).length} labels · {project.config.mediaKind} · {project.config.primitives.join(', ')}
						</div>
					</div>
				</button>
			{/each}
		</div>
	{:else if ctx.live.loaded}
		<div class="mb-4"><EmptyState title="No projects yet" hint="Create the first project below." /></div>
	{/if}

	{#if error}<div class="alert alert-error mb-3 text-sm">{error}</div>{/if}

	{#if creating}
		<div class="border-line bg-surface flex flex-col gap-3 rounded-lg border p-4">
			<input class="input" placeholder="Project name" bind:value={name} />

			{#if templates.length}
				<fieldset class="flex flex-col gap-2">
					<legend class="text-dim mb-1 text-xs font-semibold tracking-wider uppercase">Template</legend>
					{#each templates as template (template.id)}
						<label class="flex cursor-pointer items-start gap-2 text-sm">
							<input type="radio" class="mt-0.5" checked={activeTemplateId === template.id} onchange={() => applyTemplate(template)} />
							<span>
								<span class="text-default">{template.label}</span>
								<span class="text-faint block text-xs">{template.description}</span>
							</span>
						</label>
					{/each}
				</fieldset>
			{:else}
				<p class="text-dim text-xs">No project templates are registered; enter the ids by hand.</p>
			{/if}

			<label class="flex flex-col gap-1 text-sm">
				<span class="text-dim text-xs font-semibold tracking-wider uppercase">Media kind</span>
				<input class="input" list="known-media-kinds" placeholder="Media kind id" bind:value={mediaKind} />
			</label>
			<label class="flex flex-col gap-1 text-sm">
				<span class="text-dim text-xs font-semibold tracking-wider uppercase">Model</span>
				<input class="input" list="known-models" placeholder="Model provider id" bind:value={model} />
			</label>
			<label class="flex flex-col gap-1 text-sm">
				<span class="text-dim text-xs font-semibold tracking-wider uppercase">Annotation primitives</span>
				<input class="input" list="known-primitives" placeholder="Comma-separated primitive ids" bind:value={primitives} />
			</label>

			<datalist id="known-media-kinds">{#each knownMediaKinds as id (id)}<option value={id}></option>{/each}</datalist>
			<datalist id="known-models">{#each knownModels as id (id)}<option value={id}></option>{/each}</datalist>
			<datalist id="known-primitives">{#each knownPrimitives as id (id)}<option value={id}></option>{/each}</datalist>

			<div class="flex gap-2">
				<button type="button" class="btn btn-sm btn-primary" disabled={!canCreate} onclick={create}>Create</button>
				<button type="button" class="btn btn-sm btn-ghost" onclick={() => (creating = false)}>Cancel</button>
			</div>
		</div>
	{:else}
		<button type="button" class="btn btn-sm btn-outline" onclick={() => (creating = true)}><PlusIcon size={15} /> New project</button>
	{/if}
</div>
