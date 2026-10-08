<script lang="ts">
	// Export a project's labeled items to a folder, or import such a folder as a labeled session.
	import type { JobView, Project } from '@atlas/contracts';
	import { kernelContext } from '@atlas/web/kernel';

	let { project }: { project: Project } = $props();

	const ctx = kernelContext();

	let exportPath = $state('');
	let importPath = $state('');
	let error = $state('');
	let submitting = $state(false);

	const projectJobs = $derived(
		ctx.live.jobs.filter(
			(job: JobView) => (job.type === 'export' || job.type === 'import') && job.extra.projectId === project.id
		)
	);

	function messageOf(failure: unknown): string {
		if (failure instanceof Error) {
			return failure.message;
		}
		return String(failure);
	}

	function percentOf(job: JobView): number {
		if (job.total === 0) {
			return 0;
		}
		return Math.round((job.done / job.total) * 100);
	}

	async function start(action: 'export' | 'import', path: string) {
		submitting = true;
		error = '';
		try {
			await ctx.api.post(`/projects/${project.id}/${action}`, { path: path.trim() });
		} catch (failure) {
			error = messageOf(failure);
		} finally {
			submitting = false;
		}
	}
</script>

{#if error}<div class="alert alert-error mb-4 text-sm">{error}</div>{/if}

<div class="grid gap-6 md:grid-cols-2">
	<section class="border-line bg-surface flex flex-col gap-3 rounded-lg border p-4">
		<h3 class="text-default text-sm font-medium">Export labeled items</h3>
		<input class="input input-sm" placeholder="Folder (default: workspace/exports)" bind:value={exportPath} />
		<button type="button" class="btn btn-sm btn-primary self-start" disabled={submitting} onclick={() => start('export', exportPath)}>
			Export
		</button>
	</section>

	<section class="border-line bg-surface flex flex-col gap-3 rounded-lg border p-4">
		<h3 class="text-default text-sm font-medium">Import dataset</h3>
		<input class="input input-sm" placeholder="Folder containing labels.json" bind:value={importPath} />
		<button
			type="button"
			class="btn btn-sm btn-primary self-start"
			disabled={submitting || importPath.trim() === ''}
			onclick={() => start('import', importPath)}
		>
			Import
		</button>
	</section>
</div>

{#if projectJobs.length}
	<div class="mt-6 flex flex-col gap-2">
		{#each projectJobs as job (job.id)}
			<div class="border-line bg-surface rounded-lg border p-3 text-sm">
				<div class="flex items-center justify-between gap-2">
					<span class="text-default font-medium">{job.type}</span>
					<span class="text-dim text-xs">{job.state === 'running' ? job.phase : job.state}</span>
				</div>
				<div class="text-dim mt-1 truncate text-xs">{job.extra.directory}</div>
				<div class="bg-base-100 mt-2 h-1.5 overflow-hidden rounded-full">
					<div class="bg-primary h-full" style:width={`${job.state === 'done' ? 100 : percentOf(job)}%`}></div>
				</div>
				<div class="text-dim mt-1 text-xs">{job.done} / {job.total}</div>
				{#if job.error}<div class="text-error mt-1 text-xs">{job.error}</div>{/if}
			</div>
		{/each}
	</div>
{/if}
