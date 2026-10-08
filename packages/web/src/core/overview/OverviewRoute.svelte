<script lang="ts">
	import ProjectGate from '../shared/ProjectGate.svelte';
	import OverviewPage from './OverviewPage.svelte';

	let { params }: { params: Record<string, string> } = $props();
</script>

<ProjectGate {params}>
	{#snippet children(project)}
		<OverviewPage {project} />
	{/snippet}
</ProjectGate>
