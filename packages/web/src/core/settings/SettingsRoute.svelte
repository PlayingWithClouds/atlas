<script lang="ts">
	import ProjectGate from '../shared/ProjectGate.svelte';
	import SettingsPage from './SettingsPage.svelte';

	let { params }: { params: Record<string, string> } = $props();
</script>

<ProjectGate {params}>
	{#snippet children(project)}
		<SettingsPage {project} />
	{/snippet}
</ProjectGate>
