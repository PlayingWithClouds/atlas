<script lang="ts">
	import { kernelContext } from '../../../kernel/context';
	import CaretUpDownIcon from 'phosphor-svelte/lib/CaretUpDown';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import CheckIcon from 'phosphor-svelte/lib/Check';

	let { projectId }: { projectId: string } = $props();

	const ctx = kernelContext();
	let open = $state(false);

	const current = $derived(ctx.projects.find(projectId));
	const currentName = $derived.by(() => {
		if (current === undefined) {
			return projectId;
		}
		return current.name;
	});
	const pendingCount = $derived.by(() => {
		if (current === undefined) {
			return 0;
		}
		return current.items - current.labeled - current.skipped;
	});

	function pick(id: string) {
		open = false;
		if (id === projectId) return;
		ctx.router.navigate(`/projects/${encodeURIComponent(id)}/queue`);
	}

	function allProjects() {
		open = false;
		ctx.router.navigate('/projects');
	}
</script>

<div class="border-line relative border-b px-3 py-2.5">
	<button type="button" onclick={() => (open = !open)} class="hover:bg-hover flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left">
		<div class="bg-primary/15 text-primary flex h-6 w-6 shrink-0 items-center justify-center rounded text-xs font-bold">
			{currentName.slice(0, 1).toUpperCase()}
		</div>
		<div class="min-w-0 flex-1">
			<div class="text-default truncate text-sm font-semibold">{currentName}</div>
			{#if current}
				<div class="text-faint text-[10px]">{pendingCount} pending · {current.labeled} labeled</div>
			{/if}
		</div>
		<CaretUpDownIcon size={14} class="text-dim" />
	</button>

	{#if open}
		<button type="button" class="fixed inset-0 z-10 cursor-default" aria-label="Close" onclick={() => (open = false)}></button>
		<div class="border-line bg-surface absolute inset-x-3 top-full z-20 mt-1 overflow-hidden rounded-lg border shadow-lg">
			{#each ctx.projects.summaries as project (project.id)}
				<button
					type="button"
					onclick={() => pick(project.id)}
					class="hover:bg-hover flex w-full items-center gap-2 px-3 py-2 text-left text-sm {project.id === projectId ? 'text-default' : 'text-muted'}"
				>
					<span class="flex-1 truncate">{project.name}</span>
					{#if project.id === projectId}<CheckIcon size={13} />{/if}
				</button>
			{/each}
			<button
				type="button"
				onclick={allProjects}
				class="border-line text-dim hover:bg-hover hover:text-default flex w-full items-center gap-2 border-t px-3 py-2 text-left text-sm"
			>
				<PlusIcon size={13} /> All projects
			</button>
		</div>
	{/if}
</div>
