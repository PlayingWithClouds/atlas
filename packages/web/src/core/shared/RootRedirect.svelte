<script lang="ts">
	import Redirect from './Redirect.svelte';

	// Route components receive `params`; the root route has none.
	let _routeProps: { params: Record<string, string> } = $props();
</script>

<Redirect target="/projects" />
