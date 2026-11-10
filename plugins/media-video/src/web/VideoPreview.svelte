<script lang="ts">
	// Grid cell: the poster until hovered, then a muted loop of the item's span. Unmounting the
	// <video> on mouse-leave releases the decoder, so a page of cells never plays more than one.
	import type { MediaPreviewProps } from '@atlas/contracts/web';
	import FilmReelIcon from 'phosphor-svelte/lib/FilmReel';
	import { onDestroy } from 'svelte';
	import { SpanLoop } from './spanLoop';

	let { asset, span, poster }: MediaPreviewProps = $props();

	const HOVER_DELAY_MS = 150;

	let hovered = $state(false);
	let element = $state<HTMLVideoElement>();
	let hoverTimer: ReturnType<typeof setTimeout> | undefined;

	const posterUrl = $derived.by(() => {
		if (poster !== undefined) {
			return poster;
		}
		return asset.poster;
	});

	const loop = new SpanLoop({
		video: () => element,
		url: () => asset.url,
		span: () => span,
		onfail: () => (hovered = false)
	});

	function enter(): void {
		clearTimeout(hoverTimer);
		hoverTimer = setTimeout(() => (hovered = true), HOVER_DELAY_MS);
	}

	function leave(): void {
		clearTimeout(hoverTimer);
		hovered = false;
	}

	function onMetadata(): void {
		loop.onLoadedMetadata();
		element?.play().catch(() => (hovered = false));
	}

	$effect(() => {
		if (hovered) {
			return loop.load();
		}
		return undefined;
	});

	onDestroy(() => clearTimeout(hoverTimer));
</script>

<div class="bg-canvas relative aspect-video w-full overflow-hidden" role="presentation" onmouseenter={enter} onmouseleave={leave}>
	{#if posterUrl}
		<img src={posterUrl} alt="" loading="lazy" class="absolute inset-0 h-full w-full object-cover" />
	{:else}
		<div class="text-faint absolute inset-0 flex items-center justify-center"><FilmReelIcon size={28} /></div>
	{/if}
	{#if hovered}
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			bind:this={element}
			muted
			playsinline
			preload="auto"
			disablepictureinpicture
			onloadedmetadata={onMetadata}
			onplay={() => loop.start()}
			onpause={() => loop.stop()}
			onended={() => loop.onEnded()}
			class="absolute inset-0 h-full w-full object-cover"
		></video>
	{/if}
</div>
