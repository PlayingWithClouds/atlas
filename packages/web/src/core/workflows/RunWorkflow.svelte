<script lang="ts">
	// Run button for manual workflows, scoped to the session on screen. One workflow renders
	// as a plain button; several open a menu.
	import type { Workflow } from '@atlas/contracts';
	import { onMount } from 'svelte';
	import { kernelContext } from '../../kernel/context';
	import { messageOf } from '../shared/errors';
	import { listFrom } from '../shared/lists';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
	import PlayIcon from 'phosphor-svelte/lib/PlayIcon';

	let { projectId, sessionId }: { projectId: string; sessionId: string } = $props();

	const ctx = kernelContext();

	let workflows = $state<Workflow[]>([]);
	let running = $state(false);
	let open = $state(false);

	// A workflow without triggers is manual by default.
	const manual = $derived(
		workflows.filter((workflow) => workflow.triggers.length === 0 || workflow.triggers.includes('manual'))
	);

	onMount(async () => {
		try {
			const payload = await ctx.api.get(`/workflows?projectId=${encodeURIComponent(projectId)}`);
			workflows = listFrom<Workflow>(payload, 'workflows');
		} catch {
			// No button rather than an error: the session header is not where this is fixed.
		}
	});

	function summarize(workflow: Workflow): string {
		return workflow.graph.nodes.map((node) => node.type).join(' → ');
	}

	async function run(workflow: Workflow) {
		open = false;
		running = true;
		try {
			await ctx.api.post(`/sessions/${sessionId}/workflow/${workflow.id}`, {});
			ctx.toasts.push(`Started "${workflow.label}"`, 'success');
		} catch (failure) {
			ctx.toasts.push(`Could not start "${workflow.label}": ${messageOf(failure)}`, 'error');
		} finally {
			running = false;
		}
	}
</script>

{#if manual.length}
	<div class="relative">
		{#if manual.length === 1}
			<button type="button" class="btn btn-sm btn-ghost" disabled={running} title={summarize(manual[0])} onclick={() => run(manual[0])}>
				<PlayIcon size={14} />
				{running ? 'Starting…' : `Run ${manual[0].label}`}
			</button>
		{:else}
			<button type="button" class="btn btn-sm btn-ghost" disabled={running} aria-haspopup="menu" aria-expanded={open} onclick={() => (open = !open)}>
				<PlayIcon size={14} />
				{running ? 'Starting…' : 'Run workflow'}
				<CaretDownIcon size={14} />
			</button>
		{/if}

		{#if open}
			<button type="button" class="fixed inset-0 z-10 cursor-default" aria-label="Close" onclick={() => (open = false)}></button>
			<div class="border-line bg-elevated absolute right-0 z-20 mt-1 max-h-64 w-60 overflow-y-auto rounded-lg border p-1 shadow-lg" role="menu">
				{#each manual as workflow (workflow.id)}
					<button type="button" role="menuitem" class="hover:bg-hover flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left" onclick={() => run(workflow)}>
						<span class="text-default truncate text-sm">{workflow.label}</span>
						{#if summarize(workflow)}<span class="text-faint truncate text-[11px]">{summarize(workflow)}</span>{/if}
					</button>
				{/each}
			</div>
		{/if}
	</div>
{/if}
