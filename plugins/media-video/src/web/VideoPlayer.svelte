<script lang="ts">
	// Plays one span of an asset in a loop. The <video> `loop` attribute would repeat the whole
	// file, so the loop is driven per animation frame by SpanLoop. Sound is the person's choice
	// (remembered), not forced off.
	import type { MediaPlayerProps, PlayerHandle } from '@atlas/contracts/web';
	import PauseIcon from 'phosphor-svelte/lib/Pause';
	import PlayIcon from 'phosphor-svelte/lib/Play';
	import SpeakerHighIcon from 'phosphor-svelte/lib/SpeakerHigh';
	import SpeakerSlashIcon from 'phosphor-svelte/lib/SpeakerSlash';
	import { onMount } from 'svelte';
	import { DEFAULT_FRAME_RATE, FrameRateMeter, frameIndexAt, frameStepTarget } from './frames';
	import { formatTime, nextPlaybackRate } from './loopWindow';
	import { SpanLoop } from './spanLoop';

	let { asset, span, poster, onready, ontime }: MediaPlayerProps = $props();

	function posterUrl(): string | undefined {
		if (poster !== undefined) {
			return poster;
		}
		return asset.poster;
	}

	const MUTED_STORAGE_KEY = 'atlas.player.muted';

	let element = $state<HTMLVideoElement>();
	let paused = $state(true);
	let muted = $state(localStorage.getItem(MUTED_STORAGE_KEY) !== 'false');
	let rate = $state(1);
	let playhead = $state(0);
	let failure = $state('');
	let ready = $state(false);
	let measuredFrameRate = $state<number | undefined>(undefined);
	const meter = new FrameRateMeter();

	const frameRate = $derived.by(() => {
		if (asset.frameRate !== undefined && asset.frameRate > 0) {
			return asset.frameRate;
		}
		if (measuredFrameRate !== undefined) {
			return measuredFrameRate;
		}
		return DEFAULT_FRAME_RATE;
	});

	const loop = new SpanLoop({
		video: () => element,
		url: () => asset.url,
		span: () => span,
		ontime: (seconds) => {
			playhead = seconds;
			ontime?.(seconds);
		},
		onfail: (message) => (failure = message)
	});

	function elementTime(): number {
		if (element === undefined) {
			return 0;
		}
		return element.currentTime;
	}

	function play(): void {
		if (element === undefined) {
			return;
		}
		element.play().catch(retryMuted);
	}

	// Browsers refuse sound before the first interaction; fall back to muted instead of stalling.
	function retryMuted(): void {
		if (element === undefined || element.muted) {
			return;
		}
		setMuted(true);
		element.play().catch(() => undefined);
	}

	function setMuted(next: boolean): void {
		muted = next;
		localStorage.setItem(MUTED_STORAGE_KEY, String(next));
	}

	function setRate(next: number): void {
		rate = next;
	}

	function stepFrames(count: number): void {
		if (element === undefined) {
			return;
		}
		element.pause();
		loop.seek(frameStepTarget(element.currentTime, count, frameRate));
	}

	// Presented frames tell the real rate when the asset doesn't; only needed until it is known.
	function watchFrames(video: HTMLVideoElement): () => void {
		let handle = 0;
		const onFrame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
			const measured = meter.observe(metadata.mediaTime);
			if (measured !== undefined) {
				measuredFrameRate = measured;
				return;
			}
			handle = video.requestVideoFrameCallback(onFrame);
		};
		handle = video.requestVideoFrameCallback(onFrame);
		return () => video.cancelVideoFrameCallback(handle);
	}

	const handle: PlayerHandle = {
		get currentTime() {
			return elementTime();
		},
		get paused() {
			return paused;
		},
		get muted() {
			return muted;
		},
		get playbackRate() {
			return rate;
		},
		get frameRate() {
			return frameRate;
		},
		play,
		pause: () => element?.pause(),
		seek: (seconds) => loop.seek(seconds),
		stepFrames,
		setMuted,
		setPlaybackRate: setRate
	};

	function togglePlay(): void {
		if (paused) {
			play();
			return;
		}
		element?.pause();
	}

	// No autoplay: the item opens paused on its first frame; Space starts it.
	function onMetadata(): void {
		loop.onLoadedMetadata();
		ready = true;
	}

	onMount(() => onready?.(handle));

	$effect(() => {
		failure = '';
		ready = false;
		measuredFrameRate = undefined;
		return loop.load();
	});

	$effect(() => {
		const video = element;
		if (video === undefined || asset.frameRate !== undefined || measuredFrameRate !== undefined) {
			return;
		}
		if (!('requestVideoFrameCallback' in video)) {
			return;
		}
		return watchFrames(video);
	});

	$effect(() => {
		void span;
		loop.onSpanChanged();
	});

	$effect(() => {
		if (element !== undefined) {
			element.muted = muted;
		}
	});

	$effect(() => {
		if (element !== undefined) {
			element.playbackRate = rate;
		}
	});
</script>

<div class="group relative flex h-full w-full items-center justify-center overflow-hidden bg-black">
	<!-- svelte-ignore a11y_media_has_caption -->
	<video
		bind:this={element}
		playsinline
		preload="auto"
		disablepictureinpicture
		poster={posterUrl()}
		onloadedmetadata={onMetadata}
		onloadeddata={() => loop.onLoadedData()}
		onplay={() => {
			paused = false;
			loop.start();
		}}
		onpause={() => {
			paused = true;
			loop.stop();
			loop.report();
		}}
		onseeked={() => {
			meter.reset();
			loop.report();
		}}
		onended={() => loop.onEnded()}
		onerror={() => (failure = 'This video could not be loaded')}
		onclick={togglePlay}
		class="h-full w-full object-contain"
	></video>

	{#if failure}
		<div class="bg-canvas/80 text-red absolute inset-0 flex items-center justify-center p-6 text-center text-sm">{failure}</div>
	{:else if !ready}
		<div class="text-dim absolute inset-0 flex items-center justify-center"><span class="loading"></span></div>
	{/if}

	<div
		class="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/70 to-transparent px-2 pt-6 pb-1.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
	>
		<button type="button" tabindex="-1" class="btn btn-ghost btn-xs btn-square text-white" onmousedown={(event) => event.preventDefault()} onclick={togglePlay} aria-label="Play or pause">
			{#if paused}<PlayIcon size={14} weight="fill" />{:else}<PauseIcon size={14} weight="fill" />{/if}
		</button>
		<span class="font-mono text-2xs tabular-nums">{formatTime(playhead)}</span>
		<span class="font-mono text-2xs text-white/60 tabular-nums" title="Frame at {frameRate} fps (, and . step one frame)">f{frameIndexAt(playhead, frameRate)}</span>
		<span class="flex-1"></span>
		<button
			type="button"
			tabindex="-1"
			class="btn btn-ghost btn-xs text-white"
			onmousedown={(event) => event.preventDefault()}
			onclick={() => setRate(nextPlaybackRate(rate))}
			title="Playback speed"
		>
			{rate}×
		</button>
		<button
			type="button"
			tabindex="-1"
			class="btn btn-ghost btn-xs btn-square text-white"
			onmousedown={(event) => event.preventDefault()}
			onclick={() => setMuted(!muted)}
			aria-label={muted ? 'Unmute' : 'Mute'}
			title={muted ? 'Unmute (M)' : 'Mute (M)'}
		>
			{#if muted}<SpeakerSlashIcon size={14} />{:else}<SpeakerHighIcon size={14} />{/if}
		</button>
	</div>
</div>
