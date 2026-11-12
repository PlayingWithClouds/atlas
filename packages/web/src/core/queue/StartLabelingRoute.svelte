<script lang="ts">
	// /projects/:project/label without an item: opens the next pending one, or goes back to the queue.
	import type { QueueNext } from '@atlas/contracts';
	import { onMount } from 'svelte';
	import { kernelContext } from '../../kernel/context';
	import { messageOf } from '../shared/errors';
	import { apiFilterSearch } from './apiFilter';
	import { currentFilter, filterSearch } from './itemFilter';
	import { labelPath, queuePath } from './itemLink';

	let { params }: { params: Record<string, string> } = $props();

	const ctx = kernelContext();

	async function openNext() {
		const projectId = params.project;
		const search = filterSearch(currentFilter());
		try {
			const next = await ctx.api.get<QueueNext>(`/projects/${encodeURIComponent(projectId)}/queue/next${apiFilterSearch(currentFilter())}`);
			if (next.item === undefined) {
				ctx.toasts.push('Nothing pending: the queue is empty', 'info');
				ctx.router.navigate(queuePath(projectId), { replace: true });
				return;
			}
			ctx.router.navigate(labelPath(projectId, next.item.item.id) + search, { replace: true });
		} catch (failure) {
			ctx.toasts.push(messageOf(failure), 'error');
			ctx.router.navigate(queuePath(projectId), { replace: true });
		}
	}

	onMount(() => void openNext());
</script>

<div class="text-dim flex justify-center py-16"><span class="loading"></span></div>
