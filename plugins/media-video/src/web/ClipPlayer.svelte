<script lang="ts">
	// Plays one span as a muted loop. The <video> `loop` attribute would repeat the whole
	// file, so the loop is driven from timeupdate; that also keeps a direct stream inside
	// the span. If the direct stream cannot be played, it falls back to the encoded clip.
	import type { Item, Session } from '@atlas/contracts';
	import { kernelContext } from '@atlas/web/kernel';
	import { formatRange, planPlayback } from './playback';

	let {
		item,
		session,
		active = true,
		fit = 'cover',
		onTime
	}: {
		item: Item;
		session: Session;
		active?: boolean;
		fit?: 'cover' | 'contain';
		onTime?: (seconds: number) => void;
	} = $props();

	const ctx = kernelContext();

	let element = $state<HTMLVideoElement | null>(null);
	let ready = $state(false);
	let failed = $state(false);
	let forceClip = $state(false);

	const plan = $derived(planPlayback(item, session, (path) => ctx.api.url(path), forceClip));
	const poster = $derived(ctx.api.url(`/items/${item.id}/thumbnail`));
	const wholeVideo = $derived(plan.end === undefined);
	// The media fragment only hints at the first byte range; browsers disagree on its end.
	const fragmentSrc = $derived.by(() => {
		if (plan.end === undefined) return plan.src;
		return `${plan.src}#t=${plan.start.toFixed(3)},${plan.end.toFixed(3)}`;
	});

	function onLoadedMetadata() {
		if (!element) return;
		ready = true;
		element.currentTime = plan.start;
		element.play().catch(() => {
			// Autoplay can still be refused; the poster stands in.
		});
	}

	// timeupdate fires ~4x/s, so the loop restarts slightly early instead of bleeding on.
	function onTimeUpdate() {
		if (!element) return;
		onTime?.(element.currentTime);
		if (plan.end === undefined) return;
		if (element.currentTime >= plan.end - 0.03 || element.currentTime < plan.start - 0.25) {
			element.currentTime = plan.start;
		}
	}

	function onVideoError() {
		ready = false;
		if (!forceClip && item.span !== undefined) {
			forceClip = true;
			return;
		}
		failed = true;
	}

	// Releasing the source (not just pausing) frees the decoder and the connection.
	$effect(() => {
		if (!element) return;
		if (active) {
			if (element.getAttribute('src') !== fragmentSrc) {
				element.setAttribute('src', fragmentSrc);
				element.load();
			}
			return;
		}
		element.pause();
		element.removeAttribute('src');
		element.load();
		ready = false;
	});
</script>

<div class="relative h-full w-full">
	<!-- svelte-ignore a11y_media_has_caption -->
	<video
		bind:this={element}
		muted
		loop={wholeVideo}
		playsinline
		preload="metadata"
		disablepictureinpicture
		onloadedmetadata={onLoadedMetadata}
		ontimeupdate={onTimeUpdate}
		onerror={onVideoError}
		class="h-full w-full {fit === 'cover' ? 'object-cover' : 'object-contain'} {ready ? '' : 'opacity-0'}"
	></video>

	{#if !ready}
		{#if failed}
			<div class="bg-base-100 text-faint absolute inset-0 flex items-center justify-center text-[11px]">
				preview unavailable
			</div>
		{:else}
			<img
				src={poster}
				alt=""
				class="absolute inset-0 h-full w-full {fit === 'cover' ? 'object-cover' : 'object-contain'}"
			/>
			{#if item.span}
				<span class="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-white">
					{formatRange(item.span.start, item.span.end)}
				</span>
			{/if}
		{/if}
	{/if}
</div>
