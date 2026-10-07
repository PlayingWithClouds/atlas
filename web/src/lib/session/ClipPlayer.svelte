<script lang="ts">
	// Plays one temporal span: a muted, looping window over the session's video.
	// The <video> `loop` attribute would repeat the whole file, so the loop is driven
	// from timeupdate instead — that also lets the range change while dragging a trim
	// handle without reloading the source.
	import { formatRange } from '$lib/session/clip';

	let {
		src,
		start,
		end,
		active = true,
		fit = 'cover',
		poster,
		onTime,
		onError
	}: {
		src: string;
		start: number;
		end: number;
		active?: boolean;
		fit?: 'cover' | 'contain';
		poster?: string;
		onTime?: (seconds: number) => void;
		onError?: () => void;
	} = $props();

	let element = $state<HTMLVideoElement | null>(null);
	let ready = $state(false);
	let failed = $state(false);

	// The media fragment only hints at the first byte range to fetch; browsers
	// disagree on whether they honour its end value, so it is never relied on.
	const fragmentSrc = $derived(`${src}#t=${start.toFixed(3)},${end.toFixed(3)}`);

	function onLoadedMetadata() {
		if (!element) return;
		ready = true;
		element.currentTime = start;
		element.play().catch(() => {
			// Autoplay can still be refused even when muted; the poster frame stands in.
		});
	}

	// timeupdate fires roughly 4x/s, so the loop restarts slightly early rather than
	// letting the clip bleed into the next one.
	function onTimeUpdate() {
		if (!element) return;
		if (element.currentTime >= end - 0.03 || element.currentTime < start - 0.25) {
			element.currentTime = start;
		}
		onTime?.(element.currentTime);
	}

	function onVideoError() {
		failed = true;
		onError?.();
	}

	// Releasing the source (not just pausing) frees the decoder and the connection.
	// A grid keeps only a handful of clips active, and this is what makes that work.
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

	// Retighten the loop when the range moves under an already-playing clip.
	$effect(() => {
		if (!element || !ready) return;
		if (element.currentTime < start || element.currentTime > end) {
			element.currentTime = start;
		}
	});
</script>

<div class="relative h-full w-full">
	<!-- svelte-ignore a11y_media_has_caption -->
	<video
		bind:this={element}
		muted
		playsinline
		preload="metadata"
		disablepictureinpicture
		onloadedmetadata={onLoadedMetadata}
		ontimeupdate={onTimeUpdate}
		onerror={onVideoError}
		class="h-full w-full {fit === 'cover' ? 'object-cover' : 'object-contain'} {ready ? '' : 'opacity-0'}"
	></video>

	{#if !ready}
		<!-- Cover the gap until the first frame decodes: the cached poster if there is
		     one, otherwise the range as text. -->
		{#if poster && !failed}
			<img src={poster} alt="" class="absolute inset-0 h-full w-full {fit === 'cover' ? 'object-cover' : 'object-contain'}" />
		{:else}
			<div class="bg-base-100 text-faint absolute inset-0 flex items-center justify-center text-[11px]">
				{#if failed}
					preview unavailable
				{:else}
					{formatRange(start, end)}
				{/if}
			</div>
		{/if}
	{/if}
</div>
