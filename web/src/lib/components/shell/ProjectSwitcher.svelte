<script lang="ts">
	import { goto } from '$app/navigation';
	import { projects, setActiveProject } from '$lib/stores/projects';
	import CaretUpDownIcon from 'phosphor-svelte/lib/CaretUpDown';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import CheckIcon from 'phosphor-svelte/lib/Check';

	let { project }: { project: string } = $props();
	let open = $state(false);

	const current = $derived($projects.find((p) => p.id === project));

	async function pick(id: string) {
		open = false;
		if (id === project) return;
		await setActiveProject(id);
		goto(`/projects/${id}/overview`);
	}
</script>

<div class="border-line relative border-b px-3 py-2.5">
	<button
		type="button"
		onclick={() => (open = !open)}
		class="hover:bg-hover flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left"
	>
		<div class="bg-primary/15 text-primary flex h-6 w-6 shrink-0 items-center justify-center rounded text-xs font-bold">
			{(current?.name ?? '?').slice(0, 1).toUpperCase()}
		</div>
		<div class="min-w-0 flex-1">
			<div class="text-default truncate text-sm font-semibold">{current?.name ?? project}</div>
			<div class="text-faint text-[10px]">{current?.classes ?? 0} labels · {(current?.primitives ?? []).join(', ')}</div>
		</div>
		<CaretUpDownIcon size={14} class="text-dim" />
	</button>

	{#if open}
		<button type="button" class="fixed inset-0 z-10 cursor-default" aria-label="Close" onclick={() => (open = false)}></button>
		<div class="border-line bg-surface absolute inset-x-3 top-full z-20 mt-1 overflow-hidden rounded-lg border shadow-lg">
			{#each $projects as p (p.id)}
				<button
					type="button"
					onclick={() => pick(p.id)}
					class="hover:bg-hover flex w-full items-center gap-2 px-3 py-2 text-left text-sm {p.id === project ? 'text-default' : 'text-muted'}"
				>
					<span class="flex-1 truncate">{p.name}</span>
					{#if p.id === project}<CheckIcon size={13} />{/if}
				</button>
			{/each}
			<button
				type="button"
				onclick={() => { open = false; goto('/projects'); }}
				class="border-line text-dim hover:bg-hover hover:text-default flex w-full items-center gap-2 border-t px-3 py-2 text-left text-sm"
			>
				<PlusIcon size={13} /> New project
			</button>
		</div>
	{/if}
</div>
