<script lang="ts">
	import ProjectGate from '../shared/ProjectGate.svelte';
	import DataPage from './DataPage.svelte';

	let { params }: { params: Record<string, string> } = $props();
</script>

<ProjectGate {params}>
	{#snippet children(project)}
		<DataPage {project} />
	{/snippet}
</ProjectGate>
