<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { sessions } from '$lib/stores/sessions';
	import DatabaseIcon from 'phosphor-svelte/lib/Database';

	const project = $derived($page.params.project ?? 'nsfw-tags');
	const open = $derived($sessions.filter((s) => !s.done && (s.project ?? 'nsfw-tags') === project));

	// Jump straight into a session if one is open; otherwise show a chooser.
	$effect(() => {
		if (open.length === 1) goto(`/projects/${project}/session/${open[0].id}`);
	});
</script>

<div class="p-6">
	<h1 class="text-default mb-4 text-xl font-semibold tracking-tight">Annotate</h1>

	{#if open.length}
		<div class="border-line divide-line max-w-lg overflow-hidden rounded-lg border divide-y">
			{#each open as s (s.id)}
				<a href={`/projects/${project}/session/${s.id}`} class="hover:bg-hover flex items-center gap-2 px-4 py-3 text-sm">
					<span class="text-default flex-1 truncate">{s.label}</span>
					<span class="text-faint text-xs">{s.labeled}/{s.total}</span>
				</a>
			{/each}
		</div>
	{:else}
		<div class="border-line bg-surface flex max-w-lg flex-col items-start gap-3 rounded-lg border p-6">
			<p class="text-dim text-sm">No open sessions. Add a data source to start annotating.</p>
			<a href={`/projects/${project}/data`} class="btn btn-sm btn-primary"><DatabaseIcon size={15} /> Go to Data</a>
		</div>
	{/if}
</div>
