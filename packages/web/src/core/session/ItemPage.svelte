<script lang="ts">
	import type { Item, Project, SessionStatus } from '@atlas/contracts';
	import type { ItemDetail } from '@atlas/contracts/web';
	import { kernelContext } from '../../kernel/context';
	import { messageOf } from '../shared/errors';
	import EmptyState from '../../lib/components/EmptyState.svelte';

	let { project, sessionId, itemId }: { project: Project; sessionId: string; itemId: string } = $props();

	const ctx = kernelContext();

	let item = $state<Item | null>(null);
	let detail = $state<ItemDetail | undefined>(undefined);
	let status = $state<SessionStatus | null>(null);
	let error = $state('');

	const labeler = $derived(item ? ctx.itemLabelers.list().find((candidate) => candidate.matches(project, item!)) : undefined);

	$effect(() => {
		load(sessionId, itemId);
	});

	async function load(currentSessionId: string, currentItemId: string) {
		error = '';
		try {
			const [described, sessionStatus] = await Promise.all([
				ctx.api.get<ItemDetail>(`/items/${currentItemId}`),
				ctx.api.get<SessionStatus>(`/sessions/${currentSessionId}`)
			]);
			detail = described;
			item = described.item;
			status = sessionStatus;
		} catch (failure) {
			error = messageOf(failure);
		}
	}
</script>

{#if error}
	<div class="p-6"><div class="alert alert-error text-sm">{error}</div></div>
{:else if !item || !status}
	<div class="text-dim flex justify-center py-16"><span class="loading"></span></div>
{:else if labeler}
	<labeler.component {project} session={status.session} {item} {detail} />
{:else}
	<div class="p-6">
		<EmptyState
			title={`No labeler for media kind "${item.mediaKind}"`}
			hint="Enable a plugin that provides an item labeler for this media kind."
		>
			<a href={`/projects/${project.id}/session/${sessionId}`} class="btn btn-sm">Back to session</a>
		</EmptyState>
	</div>
{/if}
