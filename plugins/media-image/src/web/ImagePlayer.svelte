<script lang="ts">
	import type { MediaPlayerProps, PlayerHandle } from '@atlas/contracts/web';
	import { onMount } from 'svelte';

	let { asset, onready }: MediaPlayerProps = $props();

	let failed = $state(false);

	// A still has no time axis; the handle exists so the labeler can treat every kind alike.
	const handle: PlayerHandle = {
		currentTime: 0,
		paused: true,
		muted: true,
		playbackRate: 1,
		play: () => undefined,
		pause: () => undefined,
		seek: () => undefined,
		setMuted: () => undefined,
		setPlaybackRate: () => undefined
	};

	onMount(() => onready?.(handle));
</script>

<div class="flex h-full w-full items-center justify-center overflow-hidden bg-black">
	{#if failed}
		<span class="text-red text-sm">This image could not be loaded</span>
	{:else}
		<img src={asset.url} alt={asset.title} onerror={() => (failed = true)} class="max-h-full max-w-full object-contain" />
	{/if}
</div>
