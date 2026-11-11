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
	let selectedIndex = $state(0);

	const projectId = $derived(params.project);
	const dirty = $derived(JSON.stringify(groups) !== JSON.stringify(baseline.groups));
	const problems = $derived(taxonomyProblems(baseline, groups));
	const warnings = $derived(taxonomyWarnings(groups));
	const savedGroupIds = $derived(baseline.groups.map((group) => group.id));
	const canSave = $derived(dirty && problems.length === 0 && !saving);
	const selectedGroup = $derived(groups[selectedIndex]);

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
		selectedIndex = groups.length - 1;
	}

	function removeGroup(index: number) {
		groups.splice(index, 1);
		selectedIndex = Math.max(0, Math.min(selectedIndex, groups.length - 1));
	}

	interface OutlineEntry {
		group: Group;
		index: number;
		/** 1 for refinements, listed under the group their condition points at. */
		depth: 0 | 1;
	}

	/** Groups in list order, each refinement moved under its parent group. */
	const outline = $derived.by((): OutlineEntry[] => {
		const entries: OutlineEntry[] = [];
		const parentIds = new Set(groups.map((group) => group.id));
		groups.forEach((group, index) => {
			if (group.when !== undefined && parentIds.has(group.when.group)) return;
			entries.push({ group, index, depth: 0 });
			groups.forEach((child, childIndex) => {
				if (child.when === undefined || child.when.group !== group.id) return;
				entries.push({ group: child, index: childIndex, depth: 1 });
			});
		});
		return entries;
	});

	function groupName(group: Group): string {
		if (group.label.trim() === '') {
			return 'Untitled group';
		}
		return group.label;
	}

	function summaryOf(group: Group): string {
		const active = group.labels.filter((label) => label.deprecated !== true).length;
		const parts = [kindName(group), `${active} labels`];
		if (group.when !== undefined) {
			parts.push(`when ${conditionLabelName(group)}`);
		}
		return parts.join(' · ');
	}

	function kindName(group: Group): string {
		if (group.kind === 'single') {
			return 'one';
		}
		return 'any';
	}

	function conditionLabelName(group: Group): string {
		const condition = group.when;
		if (condition === undefined) return '';
		const parent = groups.find((candidate) => candidate.id === condition.group);
		if (parent === undefined) return condition.label;
		const label = parent.labels.find((candidate) => candidate.id === condition.label);
		if (label === undefined) return condition.label;
		return label.name;
	}

	function replaceGroups(imported: Group[]) {
		groups = imported;
		selectedIndex = 0;
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

<div class="flex h-full min-h-0 flex-col">
	<div class="border-line border-b px-6 pt-5">
		<PageHeader title="Taxonomy" subtitle={`Version ${baseline.version} · saved ids are never renamed or removed; deprecate labels instead`}>
			{#snippet actions()}
				{#if dirty}<span class="badge bg-amber-soft text-amber">unsaved</span>{/if}
				<div class="tabs tabs-box">
					<button type="button" class="tab {mode === 'editor' ? 'tab-active' : ''}" onclick={() => (mode = 'editor')}>Editor</button>
					<button type="button" class="tab {mode === 'json' ? 'tab-active' : ''}" onclick={() => (mode = 'json')}>JSON</button>
				</div>
				<button type="button" class="btn btn-primary" disabled={!canSave} onclick={save}>Save</button>
			{/snippet}
		</PageHeader>
	</div>

	{#if loading}
		<div class="text-dim flex justify-center py-16"><span class="loading"></span></div>
	{:else if mode === 'json'}
		<div class="min-h-0 flex-1 overflow-y-auto p-6">
			<JsonPane {groups} onapply={replaceGroups} />
		</div>
	{:else}
		<div class="flex min-h-0 flex-1">
			<aside class="border-line bg-canvas flex w-72 shrink-0 flex-col border-r">
				<nav class="min-h-0 flex-1 overflow-y-auto py-2">
					{#each outline as entry (entry.group)}
						<button
							type="button"
							onclick={() => (selectedIndex = entry.index)}
							class="flex w-full items-center gap-2 py-1.5 pr-3 text-left transition-colors {entry.depth === 1 ? 'pl-8' : 'pl-4'} {entry.index === selectedIndex
								? 'bg-hover text-default'
								: 'text-muted hover:bg-hover/50 hover:text-default'}"
						>
							{#if entry.depth === 1}<span class="text-violet text-xs">↳</span>{/if}
							<span class="min-w-0 flex-1">
								<span class="block truncate text-sm {entry.group.primary ? 'font-medium' : ''}">{groupName(entry.group)}</span>
								<span class="text-faint block truncate text-2xs">{summaryOf(entry.group)}</span>
							</span>
							{#if entry.group.primary}<span class="bg-green size-1.5 shrink-0 rounded-full" title="Primary"></span>{/if}
						</button>
					{/each}
					<button type="button" class="btn btn-ghost btn-sm mx-3 mt-2" onclick={addGroup}><PlusIcon size={13} /> Add group</button>
				</nav>

				<div class="border-line flex flex-col gap-1.5 border-t p-3">
					<label class="text-dim text-xs" for="prefill-source">Prefill suggestions from source</label>
					<div class="flex gap-1.5">
						<input id="prefill-source" class="input input-sm font-mono" placeholder="newest source" bind:value={prefillSource} />
						<button type="button" class="btn btn-sm btn-outline" disabled={prefillSource.trim() === savedPrefillSource} onclick={savePrefillSource}>Set</button>
					</div>
				</div>
			</aside>

			<div class="min-h-0 flex-1 overflow-y-auto">
				<div class="mx-auto flex max-w-4xl flex-col gap-3 p-6">
					{#if changedElsewhere}
						<div class="alert alert-info">
							The taxonomy was changed elsewhere.
							<button type="button" class="btn btn-sm btn-outline ml-auto" onclick={() => void load()}>Discard my edits and reload</button>
						</div>
					{/if}
					{#if serverProblems.length}
						<div class="alert alert-error flex-col items-start">
							<strong>The server rejected the taxonomy</strong>
							{#each serverProblems as problem (problem)}<span>{problem}</span>{/each}
						</div>
					{/if}
					{#if dirty && problems.length}
						<div class="alert alert-error flex-col items-start">
							{#each problems as problem (problem)}<span>{problem}</span>{/each}
						</div>
					{/if}
					{#if warnings.length}
						<div class="alert flex-col items-start">
							{#each warnings as warning (warning)}<span class="text-amber">{warning}</span>{/each}
						</div>
					{/if}

					{#if selectedGroup !== undefined}
						{#key selectedGroup}
							<GroupEditor
								bind:group={groups[selectedIndex]}
								allGroups={groups}
								saved={savedGroupIds.includes(selectedGroup.id)}
								savedLabelIds={savedLabelIdsOf(selectedGroup.id)}
								otherGroupIds={groups.filter((_, position) => position !== selectedIndex).map((other) => other.id)}
								onremove={() => removeGroup(selectedIndex)}
							/>
						{/key}
					{:else}
						<p class="text-dim py-16 text-center text-sm">No groups yet. Add one on the left.</p>
					{/if}
				</div>
			</div>
		</div>
	{/if}
</div>
