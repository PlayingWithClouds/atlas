<script lang="ts">
	import type { Project, ProjectInput } from '@atlas/contracts';
	import { kernelContext } from '../../kernel/context';
	import EmptyState from '../../lib/components/EmptyState.svelte';
	import { problemsOf } from '../shared/errors';
	import ProgressBar from '../shared/ProgressBar.svelte';
	import { slugify } from '../taxonomy/taxonomyEdit';
	import PlusIcon from 'phosphor-svelte/lib/Plus';

	// Route components receive `params`; the list page has none.
	let _routeProps: { params: Record<string, string> } = $props();

	const ctx = kernelContext();

	let creating = $state(false);
	let name = $state('');
	let projectId = $state('');
	let idEdited = $state(false);
	let busy = $state(false);
	let problems = $state<string[]>([]);

	const canCreate = $derived(name.trim() !== '' && projectId !== '' && !busy);

	function onNameInput() {
		if (!idEdited) {
			projectId = slugify(name);
		}
	}

	function onIdInput() {
		idEdited = true;
	}

	async function create() {
		if (!canCreate) return;
		busy = true;
		problems = [];
		const input: ProjectInput = { id: projectId, name: name.trim() };
		try {
			const project = await ctx.api.post<Project>('/projects', input);
			await ctx.projects.refresh();
			ctx.router.navigate(`/projects/${encodeURIComponent(project.id)}/taxonomy`);
		} catch (failure) {
			problems = problemsOf(failure);
		} finally {
			busy = false;
		}
	}

	function openProject(id: string) {
		ctx.router.navigate(`/projects/${encodeURIComponent(id)}/queue`);
	}
</script>

<div class="mx-auto max-w-2xl p-8">
	<h1 class="text-default mb-1 text-2xl font-semibold tracking-tight">Projects</h1>
	<p class="text-dim mb-6 text-sm">A project holds a taxonomy, the items to label and the labels people gave them.</p>

	{#if ctx.projects.error}<div class="alert alert-error mb-3">{ctx.projects.error}</div>{/if}

	{#if ctx.projects.summaries.length}
		<div class="border-line divide-line mb-4 divide-y overflow-hidden rounded-lg border">
			{#each ctx.projects.summaries as project (project.id)}
				<button type="button" onclick={() => openProject(project.id)} class="hover:bg-hover flex w-full items-center gap-3 px-4 py-3 text-left">
					<div class="bg-primary/15 text-primary flex h-8 w-8 items-center justify-center rounded font-bold">{project.name.slice(0, 1).toUpperCase()}</div>
					<div class="min-w-0 flex-1">
						<div class="text-default text-sm font-medium">{project.name}</div>
						<div class="text-faint font-mono text-xs">{project.id}</div>
					</div>
					<div class="w-40 shrink-0">
						<ProgressBar labeled={project.labeled} skipped={project.skipped} total={project.items} />
						<div class="text-faint mt-1 text-right text-2xs">
							{project.labeled + project.skipped} / {project.items} done
						</div>
					</div>
				</button>
			{/each}
		</div>
	{:else if ctx.projects.loaded}
		<div class="mb-4"><EmptyState title="No projects yet" hint="Create the first project below, then point an adapter at it." /></div>
	{/if}

	{#if creating}
		<form
			class="border-line bg-surface flex flex-col gap-3 rounded-lg border p-4"
			onsubmit={(event) => {
				event.preventDefault();
				void create();
			}}
		>
			{#if problems.length}
				<div class="alert alert-error flex-col items-start">
					{#each problems as problem (problem)}<span>{problem}</span>{/each}
				</div>
			{/if}
			<label class="form-control">
				<span class="label-text">Name</span>
				<input class="input" placeholder="Scene classification" bind:value={name} oninput={onNameInput} />
			</label>
			<label class="form-control">
				<span class="label-text">Id (used in adapter URLs, cannot change)</span>
				<input class="input font-mono" placeholder="scenes" bind:value={projectId} oninput={onIdInput} />
			</label>
			<div class="flex gap-2">
				<button type="submit" class="btn btn-sm btn-primary" disabled={!canCreate}>Create</button>
				<button type="button" class="btn btn-sm btn-ghost" onclick={() => (creating = false)}>Cancel</button>
			</div>
		</form>
	{:else}
		<button type="button" class="btn btn-sm btn-outline" onclick={() => (creating = true)}><PlusIcon size={15} /> New project</button>
	{/if}
</div>
