<script lang="ts">
	import SessionRoutes from './SessionRoutes.svelte';

	let { params }: { params: Record<string, string> } = $props();
</script>

<SessionRoutes {params} view="index" />
