<script lang="ts">
	import Redirect from './Redirect.svelte';

	let { params }: { params: Record<string, string> } = $props();
</script>

<Redirect target={`/projects/${encodeURIComponent(params.project)}/queue`} />
