<script lang="ts">
	import type { Project, SessionStatus } from '@atlas/contracts';
	import { kernelContext } from '../../kernel/context';
	import { messageOf } from '../shared/errors';
	import EmptyState from '../../lib/components/EmptyState.svelte';
	import RunWorkflow from '../workflows/RunWorkflow.svelte';

	let { project, sessionId }: { project: Project; sessionId: string } = $props();

	const ctx = kernelContext();

	let status = $state<SessionStatus | null>(null);
	let error = $state('');

	// Highest priority wins among labelers whose `matches` accepts the project.
	const labeler = $derived(
		ctx.gridLabelers.list().find((candidate) => candidate.matches(project))
	);
	// Grid labelers render toolbar actions themselves (with their selection); the page only
	// offers them while no labeler is active.
	const fallbackActions = $derived.by(() => {
		if (labeler || !status) return [];
		return ctx.toolbarActions.list().filter((action) => action.when(project, status!.session));
	});

	async function loadStatus(id: string) {
		error = '';
		try {
			status = await ctx.api.get<SessionStatus>(`/sessions/${id}`);
		} catch (failure) {
			error = messageOf(failure);
		}
	}

	// Reload when this session's counters change (labels made here or by a workflow).
	const progressKey = $derived.by(() => {
		const summary = ctx.live.sessions.find((candidate) => candidate.id === sessionId);
		if (!summary) return 'none';
		return `${summary.total}:${summary.labeled}:${summary.skipped}:${summary.producing}`;
	});

	$effect(() => {
		void progressKey;
		loadStatus(sessionId);
	});

	async function runAction(actionId: string) {
		const action = ctx.toolbarActions.get(actionId);
		if (!action || !status) return;
		try {
			await action.run(project, status.session, []);
		} catch (failure) {
			ctx.toasts.push(messageOf(failure), 'error');
		}
	}
</script>

{#if error}
	<div class="p-6"><div class="alert alert-error text-sm">{error}</div></div>
{:else if !status}
	<div class="text-dim flex justify-center py-16"><span class="loading"></span></div>
{:else}
	<div class="flex h-full flex-col">
		<div class="border-line flex items-center gap-3 border-b px-4 py-2.5">
			<h1 class="text-default truncate text-sm font-semibold">{status.session.label}</h1>
			<span class="text-faint text-xs">{status.labeled}/{status.total} labeled</span>
			{#if status.session.producing}<span class="loading loading-xs"></span>{/if}
			<div class="ml-auto flex items-center gap-1">
				{#each fallbackActions as action (action.id)}
					<button type="button" class="btn btn-sm btn-ghost" onclick={() => runAction(action.id)}>
						{#if action.icon}<action.icon size={14} />{/if}
						{action.label}
					</button>
				{/each}
				<RunWorkflow projectId={project.id} {sessionId} />
			</div>
		</div>

		<div class="min-h-0 flex-1 overflow-y-auto">
			{#if labeler}
				<labeler.component {project} session={status.session} />
			{:else}
				<div class="p-6">
					<EmptyState
						title={`No labeler for media kind "${project.config.mediaKind}"`}
						hint="Enable a plugin that provides a grid labeler for this media kind and its annotation primitives."
					/>
				</div>
			{/if}
		</div>
	</div>
{/if}
