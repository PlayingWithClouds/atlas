<script lang="ts">
	import type { Project } from '@atlas/contracts';
	import { kernelContext } from '../../kernel/context';
	import { messageOf } from '../shared/errors';
	import { countClasses, groupsToText, textToGroups } from './taxonomy';
	import CheckIcon from 'phosphor-svelte/lib/CheckIcon';

	let { project }: { project: Project } = $props();

	const ctx = kernelContext();

	// Seeded once per project; later live updates must not clobber unsaved edits.
	// svelte-ignore state_referenced_locally
	let name = $state(project.name);
	// svelte-ignore state_referenced_locally
	let taxonomyText = $state(groupsToText(project.config.labels.groups));
	let saved = $state(false);
	let error = $state('');

	const parsedGroups = $derived(textToGroups(taxonomyText, project.config.labels.groups));
	const classCount = $derived(countClasses(parsedGroups));

	async function save() {
		error = '';
		try {
			await ctx.api.put(`/projects/${project.id}`, {
				name: name.trim(),
				config: { labels: { groups: parsedGroups } }
			});
			saved = true;
			setTimeout(() => (saved = false), 1500);
		} catch (failure) {
			error = messageOf(failure);
		}
	}

	function reset() {
		name = project.name;
		taxonomyText = groupsToText(project.config.labels.groups);
	}
</script>

{#if error}<div class="alert alert-error mb-4 text-sm">{error}</div>{/if}

<div class="border-line bg-surface mb-6 rounded-lg border p-4">
	<label class="text-default mb-1 block text-sm font-semibold" for="project-name">Name</label>
	<input id="project-name" class="input w-full" bind:value={name} />
	<dl class="text-dim mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
		<dt>Media kind</dt><dd class="text-default font-mono">{project.config.mediaKind}</dd>
		<dt>Model</dt><dd class="text-default font-mono">{project.config.model}</dd>
		<dt>Primitives</dt><dd class="text-default font-mono">{project.config.primitives.join(', ') || '—'}</dd>
	</dl>
</div>

<h2 class="text-default mb-1 text-sm font-semibold">Taxonomy</h2>
<p class="text-dim mb-4 text-sm">
	One class per line. Lines starting with <code>#</code> start a new group. Existing icons and definitions are kept by class name.
</p>

<div class="mb-3 flex items-center gap-3">
	<span class="text-dim text-sm">{classCount} classes in {parsedGroups.length} groups</span>
	<div class="ml-auto flex gap-2">
		<button type="button" class="btn btn-sm btn-ghost" onclick={reset}>Revert</button>
		<button type="button" class="btn btn-sm btn-primary" disabled={!name.trim()} onclick={save}>
			{#if saved}<CheckIcon size={15} /> Saved{:else}Save{/if}
		</button>
	</div>
</div>

<textarea class="input h-[50vh] w-full resize-none py-3 font-mono text-xs leading-relaxed" spellcheck="false" bind:value={taxonomyText}></textarea>
