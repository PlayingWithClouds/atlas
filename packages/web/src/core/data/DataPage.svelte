<script lang="ts">
	import type { Project, SourceRef } from '@atlas/contracts';
	import { onMount } from 'svelte';
	import { kernelContext } from '../../kernel/context';
	import { messageOf } from '../shared/errors';
	import EmptyState from '../../lib/components/EmptyState.svelte';
	import PageHeader from '../shared/PageHeader.svelte';
	import GenericSourceBrowser from './GenericSourceBrowser.svelte';
	import TrashIcon from 'phosphor-svelte/lib/Trash';

	let { project }: { project: Project } = $props();

	interface SourceKindView {
		id: string;
		label: string;
		itemNoun: string;
		browsable: boolean;
		provider: string;
	}

	const ctx = kernelContext();

	let kinds = $state<SourceKindView[]>([]);
	let activeKey = $state('');
	let loaded = $state(false);
	let error = $state('');
	let confirmingRemoval = $state<string | null>(null);
	let removing = $state<string | null>(null);

	const activeKind = $derived(kinds.find((kind) => keyOf(kind) === activeKey));
	const picker = $derived(ctx.sourcePickers.list().find((candidate) => candidate.sourceKind === activeKey));
	const projectSessions = $derived(ctx.live.sessions.filter((session) => session.projectId === project.id));

	function keyOf(kind: SourceKindView): string {
		return `${kind.provider}:${kind.id}`;
	}

	onMount(async () => {
		try {
			kinds = await ctx.api.get<SourceKindView[]>('/sources/kinds');
			if (kinds.length) activeKey = keyOf(kinds[0]);
		} catch (failure) {
			error = messageOf(failure);
		} finally {
			loaded = true;
		}
	});

	async function openSource(kind: SourceKindView, params: Record<string, unknown>) {
		const source: SourceRef = { plugin: kind.provider, kind: kind.id, params };
		const status = await ctx.api.post<{ session: { id: string } }>('/sessions', { projectId: project.id, source });
		ctx.router.navigate(`/projects/${project.id}/session/${status.session.id}`);
	}

	async function removeSession(sessionId: string) {
		removing = sessionId;
		error = '';
		try {
			await ctx.api.delete(`/sessions/${sessionId}`);
		} catch (failure) {
			error = messageOf(failure);
		} finally {
			removing = null;
			confirmingRemoval = null;
		}
	}
</script>

<div class="p-6">
	<PageHeader title="Data" />

	{#if error}<div class="alert alert-error mb-4 text-sm">{error}</div>{/if}

	{#if loaded && !kinds.length}
		<EmptyState title="No data sources" hint="Enable a source plugin to open data in this project." />
	{/if}

	<div class="border-line mb-4 flex items-center gap-1 border-b">
		{#each kinds as kind (keyOf(kind))}
			<button
				type="button"
				onclick={() => (activeKey = keyOf(kind))}
				class="-mb-px border-b-2 px-3 py-2 text-sm transition-colors {activeKey === keyOf(kind)
					? 'border-primary text-default font-medium'
					: 'text-dim hover:text-default border-transparent'}"
			>
				{kind.label}
			</button>
		{/each}
	</div>

	{#if activeKind}
		{#key activeKey}
			{#if picker}
				<picker.component {project} open={(params) => openSource(activeKind, params)} />
			{:else}
				<GenericSourceBrowser
					provider={activeKind.provider}
					kind={activeKind.id}
					label={activeKind.label}
					browsable={activeKind.browsable}
					open={(params) => openSource(activeKind, params)}
				/>
			{/if}
		{/key}
	{/if}

	{#if projectSessions.length}
		<h2 class="text-dim mt-8 mb-2 text-[11px] font-semibold tracking-wider uppercase">Opened sources</h2>
		<div class="border-line divide-line max-w-2xl divide-y overflow-hidden rounded-lg border">
			{#each projectSessions as session (session.id)}
				<div class="flex items-center gap-3 px-3 py-2 text-sm">
					<a href={`/projects/${project.id}/session/${session.id}`} class="text-default hover:text-primary min-w-0 flex-1 truncate">
						{session.label}
					</a>
					<span class="text-faint shrink-0 text-xs">{session.labeled}/{session.total}</span>
					{#if session.producing}<span class="loading loading-xs shrink-0"></span>{/if}

					{#if confirmingRemoval === session.id}
						<span class="text-dim shrink-0 text-xs">Remove {session.total} items?</span>
						<button type="button" class="btn btn-xs btn-ghost text-error shrink-0" disabled={removing === session.id} onclick={() => removeSession(session.id)}>
							{removing === session.id ? 'Removing…' : 'Remove'}
						</button>
						<button type="button" class="btn btn-xs btn-ghost shrink-0" onclick={() => (confirmingRemoval = null)}>Cancel</button>
					{:else}
						<button type="button" class="btn btn-xs btn-ghost shrink-0" title="Remove this source and everything labeled in it" onclick={() => (confirmingRemoval = session.id)}>
							<TrashIcon size={14} />
						</button>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
