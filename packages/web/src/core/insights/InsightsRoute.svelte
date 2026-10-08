<script lang="ts">
	import ProjectGate from '../shared/ProjectGate.svelte';
	import InsightsPage from './InsightsPage.svelte';

	let { params }: { params: Record<string, string> } = $props();
</script>

<ProjectGate {params}>
	{#snippet children(project)}
		<InsightsPage {project} />
	{/snippet}
</ProjectGate>
