<script lang="ts">
	import ProjectGate from '../shared/ProjectGate.svelte';
	import WorkflowsPage from './WorkflowsPage.svelte';

	let { params }: { params: Record<string, string> } = $props();
</script>

<ProjectGate {params}>
	{#snippet children(project)}
		<WorkflowsPage {project} />
	{/snippet}
</ProjectGate>
