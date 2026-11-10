<script lang="ts">
	import type { Group, Project, Taxonomy } from '@atlas/contracts';
	import { onMount, untrack } from 'svelte';
	import { kernelContext } from '../../kernel/context';
	import { problemsOf } from '../shared/errors';
	import PageHeader from '../shared/PageHeader.svelte';
	import GroupEditor from './GroupEditor.svelte';
	import JsonPane from './JsonPane.svelte';
	import { cloneGroups, newGroup, taxonomyProblems, taxonomyWarnings } from './taxonomyEdit';
	import PlusIcon from 'phosphor-svelte/lib/Plus';

	let { params }: { params: Record<string, string> } = $props();

	const ctx = kernelContext();

	let baseline = $state.raw<Taxonomy>({ version: 0, groups: [] });
	let prefillSource = $state('');
	let savedPrefillSource = $state('');
	let groups = $state<Group[]>([]);
	let mode = $state<'editor' | 'json'>('editor');
	let loading = $state(true);
	let saving = $state(false);
	let serverProblems = $state<string[]>([]);
	let changedElsewhere = $state(false);

	const projectId = $derived(params.project);
	const dirty = $derived(JSON.stringify(groups) !== JSON.stringify(baseline.groups));
	const problems = $derived(taxonomyProblems(baseline, groups));
	const warnings = $derived(taxonomyWarnings(groups));
	const savedGroupIds = $derived(baseline.groups.map((group) => group.id));
	const canSave = $derived(dirty && problems.length === 0 && !saving);

	function savedLabelIdsOf(groupId: string): string[] {
		const saved = baseline.groups.find((group) => group.id === groupId);
		if (saved === undefined) {
			return [];
		}
		return saved.labels.map((label) => label.id);
	}

	function adopt(taxonomy: Taxonomy) {
		baseline = taxonomy;
		groups = cloneGroups(taxonomy.groups);
		changedElsewhere = false;
	}

	async function load() {
		const project = await ctx.api.get<Project>(`/projects/${encodeURIComponent(projectId)}`);
		adopt(project.taxonomy);
		prefillSource = '';
		if (project.prefillSource !== undefined) {
			prefillSource = project.prefillSource;
		}
		savedPrefillSource = prefillSource;
		loading = false;
	}

	async function save() {
		if (!canSave) return;
		saving = true;
		serverProblems = [];
		try {
			const saved = await ctx.api.put<Taxonomy>(`/projects/${encodeURIComponent(projectId)}/taxonomy`, { version: baseline.version, groups });
			adopt(saved);
			ctx.toasts.push(`Taxonomy saved (version ${saved.version})`, 'success');
		} catch (failure) {
			serverProblems = problemsOf(failure);
		} finally {
			saving = false;
		}
	}

	async function savePrefillSource() {
		const source = prefillSource.trim();
		try {
			await ctx.api.patch(`/projects/${encodeURIComponent(projectId)}`, { prefillSource: source });
			savedPrefillSource = source;
			ctx.toasts.push('Prefill source saved', 'success');
		} catch (failure) {
			ctx.toasts.push(problemsOf(failure).join('; '), 'error');
		}
	}

	function addGroup() {
		groups.push(newGroup(groups));
	}

	function removeGroup(index: number) {
		groups.splice(index, 1);
	}

	function replaceGroups(imported: Group[]) {
		groups = imported;
		mode = 'editor';
	}

	function onTaxonomyChanged(changed: Taxonomy) {
		if (changed.version === baseline.version) return;
		if (dirty) {
			changedElsewhere = true;
			return;
		}
		adopt(changed);
	}

	$effect(() => {
		void projectId;
		untrack(() => {
			loading = true;
			load().catch((failure) => (serverProblems = problemsOf(failure)));
		});
	});

	onMount(() =>
		ctx.live.subscribe((signal) => {
			if (signal.type === 'taxonomy' && signal.projectId === projectId) {
				onTaxonomyChanged(signal.taxonomy);
			}
		})
	);
</script>

<div class="mx-auto max-w-5xl p-6">
	<PageHeader title="Taxonomy" subtitle={`Version ${baseline.version} · saved ids are never renamed or removed; deprecate labels instead`}>
		{#snippet actions()}
			<div class="tabs tabs-box">
				<button type="button" class="tab {mode === 'editor' ? 'tab-active' : ''}" onclick={() => (mode = 'editor')}>Editor</button>
				<button type="button" class="tab {mode === 'json' ? 'tab-active' : ''}" onclick={() => (mode = 'json')}>JSON</button>
			</div>
			<button type="button" class="btn btn-primary" disabled={!canSave} onclick={save}>Save</button>
		{/snippet}
	</PageHeader>

	{#if changedElsewhere}
		<div class="alert alert-info mb-3">
			The taxonomy was changed elsewhere.
			<button type="button" class="btn btn-sm btn-outline ml-auto" onclick={() => void load()}>Discard my edits and reload</button>
		</div>
	{/if}

	{#if serverProblems.length}
		<div class="alert alert-error mb-3 flex-col items-start">
			<strong>The server rejected the taxonomy</strong>
			{#each serverProblems as problem (problem)}<span>{problem}</span>{/each}
		</div>
	{/if}

	{#if dirty && problems.length}
		<div class="alert alert-error mb-3 flex-col items-start">
			{#each problems as problem (problem)}<span>{problem}</span>{/each}
		</div>
	{/if}

	{#if warnings.length}
		<div class="alert mb-3 flex-col items-start">
			{#each warnings as warning (warning)}<span class="text-amber">{warning}</span>{/each}
		</div>
	{/if}

	{#if loading}
		<div class="text-dim flex justify-center py-16"><span class="loading"></span></div>
	{:else if mode === 'json'}
		<JsonPane {groups} onapply={replaceGroups} />
	{:else}
		<div class="flex flex-col gap-3">
			{#each groups as group, index (group)}
				<GroupEditor
					bind:group={groups[index]}
					allGroups={groups}
					saved={savedGroupIds.includes(group.id)}
					savedLabelIds={savedLabelIdsOf(group.id)}
					otherGroupIds={groups.filter((_, position) => position !== index).map((other) => other.id)}
					onremove={() => removeGroup(index)}
				/>
			{/each}
			<button type="button" class="btn btn-outline self-start" onclick={addGroup}><PlusIcon size={14} /> Add group</button>
		</div>

		<div class="border-line mt-8 flex items-center gap-2 border-t pt-4">
			<label class="text-muted text-sm" for="prefill-source">Prefill suggestions from source</label>
			<input id="prefill-source" class="input input-sm w-48 font-mono" placeholder="newest source" bind:value={prefillSource} />
			<button type="button" class="btn btn-sm btn-outline" disabled={prefillSource.trim() === savedPrefillSource} onclick={savePrefillSource}>Set</button>
		</div>
	{/if}
</div>
