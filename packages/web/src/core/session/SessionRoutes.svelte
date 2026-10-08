<script lang="ts">
	import ProjectGate from '../shared/ProjectGate.svelte';
	import ItemPage from './ItemPage.svelte';
	import SessionIndexPage from './SessionIndexPage.svelte';
	import SessionPage from './SessionPage.svelte';

	let { params, view }: { params: Record<string, string>; view: 'index' | 'session' | 'item' } = $props();
</script>

<ProjectGate {params}>
	{#snippet children(project)}
		{#if view === 'index'}
			<SessionIndexPage {project} />
		{:else if view === 'session'}
			<SessionPage {project} sessionId={params.session} />
		{:else}
			<ItemPage {project} sessionId={params.session} itemId={params.item} />
		{/if}
	{/snippet}
</ProjectGate>
