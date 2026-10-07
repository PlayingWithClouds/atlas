<script lang="ts">
	import '@fontsource-variable/geist';
	import '$lib/design/app.css';
	import { onMount } from 'svelte';
	import { connectLive } from '$lib/stores/live';
	import { theme } from '$lib/stores/theme';
	import { togglePalette } from '$lib/stores/palette';
	import CommandPalette from '$lib/components/CommandPalette.svelte';

	let { children } = $props();

	$effect(() => {
		document.documentElement.setAttribute('data-theme', $theme);
	});

	onMount(connectLive);

	function onKeydown(event: KeyboardEvent) {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
			event.preventDefault();
			togglePalette();
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

<CommandPalette />
{@render children()}
