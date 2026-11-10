<script lang="ts">
	import type { ItemView } from '@atlas/contracts';
	import { kernelContext } from '../../kernel/context';
	import StatusChip from '../../lib/components/StatusChip.svelte';
	import { formatSpan } from '../shared/time';
	import { labelPath } from './itemLink';

	let { projectId, view }: { projectId: string; view: ItemView } = $props();

	const ctx = kernelContext();

	const media = $derived(ctx.mediaPlayers.list().find((candidate) => candidate.kind === view.asset.kind));
	const poster = $derived.by(() => {
		if (view.item.poster !== undefined) {
			return view.item.poster;
		}
		return view.asset.poster;
	});
	const title = $derived.by(() => {
		if (view.asset.title !== undefined) {
			return view.asset.title;
		}
		return view.asset.id;
	});
</script>

<a
	href={labelPath(projectId, view.item.id)}
	class="bg-surface border-line hover:border-line-strong group flex flex-col overflow-hidden rounded-lg border transition-colors"
>
	{#if media}
		<media.preview asset={view.asset} span={view.item.span} {poster} />
	{:else if poster}
		<img src={poster} alt="" loading="lazy" class="aspect-video w-full object-cover" />
	{:else}
		<div class="bg-canvas aspect-video w-full"></div>
	{/if}
	<div class="flex flex-col gap-1.5 p-2.5">
		<div class="text-default truncate text-sm font-medium" title={title}>{title}</div>
		<div class="flex items-center gap-2">
			<StatusChip status={view.status} />
			{#if view.item.span}
				<span class="text-dim font-mono text-[11px]">{formatSpan(view.item.span)}</span>
			{/if}
			{#if view.priority !== undefined}
				<span class="text-faint ml-auto font-mono text-[11px]" title="Priority">p {view.priority.toFixed(2)}</span>
			{/if}
		</div>
	</div>
</a>
