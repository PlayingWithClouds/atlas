<script lang="ts">
	import { goto } from '$app/navigation';
	import { projects, loadProjects, setActiveProject } from '$lib/stores/projects';
	import { createProject, type ProjectConfig } from '$lib/api/projects';
	import PlusIcon from 'phosphor-svelte/lib/Plus';

	type ContentChoice = 'images' | 'video' | 'regions';

	let creating = $state(false);
	let name = $state('');
	let contentChoice = $state<ContentChoice>('images');
	let busy = $state(false);
	let error = $state('');

	const contentOptions: { value: ContentChoice; label: string; hint: string }[] = [
		{ value: 'images', label: 'Images', hint: 'Stills and extracted video frames, labeled with tags' },
		{
			value: 'video',
			label: 'Video clips',
			hint: 'Time ranges over a video, cut by a Segment video workflow step and embedded by the siglip plugin'
		},
		{ value: 'regions', label: 'Regions', hint: 'Bounding boxes, polygons and keypoints on images' }
	];

	// A clip project still labels with tags; what differs is the entity (a time range)
	// and therefore the backbone that embeds it.
	function configFor(choice: ContentChoice): Partial<ProjectConfig> {
		if (choice === 'regions') {
			return { primitives: ['rect', 'polygon', 'keypoint'], labels: { groups: [] } };
		}
		if (choice === 'video') {
			return { primitives: ['tag'], labels: { groups: [] }, contentKind: 'video', model: 'siglip' };
		}
		return { primitives: ['tag'], labels: { groups: [] }, contentKind: 'image' };
	}

	async function open(id: string) {
		await setActiveProject(id);
		goto(`/projects/${id}/overview`);
	}

	async function create() {
		if (!name.trim()) return;
		busy = true;
		error = '';
		try {
			const project = await createProject(name.trim(), configFor(contentChoice));
			await loadProjects();
			await open(project.id);
		} catch (e) {
			error = String(e);
		} finally {
			busy = false;
		}
	}
</script>

<div class="mx-auto max-w-2xl p-8">
	<h1 class="text-default mb-1 text-2xl font-semibold tracking-tight">Projects</h1>
	<p class="text-dim mb-6 text-sm">A project bundles a label schema, its data, and its own model pool.</p>

	<div class="border-line divide-line mb-4 overflow-hidden rounded-lg border divide-y">
		{#each $projects as p (p.id)}
			<button type="button" onclick={() => open(p.id)} class="hover:bg-hover flex w-full items-center gap-3 px-4 py-3 text-left">
				<div class="bg-primary/15 text-primary flex h-8 w-8 items-center justify-center rounded font-bold">{p.name.slice(0, 1).toUpperCase()}</div>
				<div class="flex-1">
					<div class="text-default text-sm font-medium">{p.name}</div>
					<div class="text-faint text-xs">{p.classes} labels · {p.primitives.join(', ')}</div>
				</div>
			</button>
		{/each}
	</div>

	{#if error}<div class="alert alert-error mb-3 text-sm">{error}</div>{/if}

	{#if creating}
		<div class="border-line bg-surface flex flex-col gap-3 rounded-lg border p-4">
			<input class="input" placeholder="Project name" bind:value={name} onkeydown={(e) => e.key === 'Enter' && create()} />
			<fieldset class="flex flex-col gap-2">
				<legend class="text-dim mb-1 text-xs font-semibold tracking-wider uppercase">Content</legend>
				{#each contentOptions as option (option.value)}
					<label class="flex cursor-pointer items-start gap-2 text-sm">
						<input type="radio" class="mt-0.5" value={option.value} bind:group={contentChoice} />
						<span>
							<span class="text-default">{option.label}</span>
							<span class="text-faint block text-xs">{option.hint}</span>
						</span>
					</label>
				{/each}
			</fieldset>
			<div class="flex gap-2">
				<button type="button" class="btn btn-sm btn-primary" disabled={!name.trim() || busy} onclick={create}>Create</button>
				<button type="button" class="btn btn-sm btn-ghost" onclick={() => (creating = false)}>Cancel</button>
			</div>
		</div>
	{:else}
		<button type="button" class="btn btn-sm btn-outline" onclick={() => (creating = true)}><PlusIcon size={15} /> New project</button>
	{/if}
</div>
