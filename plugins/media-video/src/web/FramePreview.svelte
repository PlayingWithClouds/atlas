<script lang="ts">
	// The still at one moment, for the timeline's hover preview: the thumbnail track's tile right away
	// (when the asset has one), then the exact frame once grabbed. Stale answers are dropped so the
	// picture always belongs to the latest position.
	import type { FramePreviewProps } from '@atlas/contracts/web';
	import { onDestroy } from 'svelte';
	import { Stills, paintStill } from './stills';
	import type { Still } from './stills';

	let { asset, seconds }: FramePreviewProps = $props();

	let canvas = $state<HTMLCanvasElement>();
	let exact = $state(false);
	let painted = $state(false);
	let stills: Stills | undefined;
	let stillsUrl = '';
	let latest = 0;

	function stillsFor(): Stills {
		if (stills === undefined || stillsUrl !== asset.url) {
			stills?.release();
			stills = new Stills(asset);
			stillsUrl = asset.url;
		}
		return stills;
	}

	function paint(request: number, still: Still | undefined): boolean {
		if (request !== latest || !(canvas instanceof HTMLCanvasElement) || still === undefined) {
			return false;
		}
		paintStill(canvas, still);
		painted = true;
		return true;
	}

	async function show(at: number): Promise<void> {
		latest += 1;
		const request = latest;
		const source = stillsFor();
		exact = false;
		paint(request, await source.quick(at));
		exact = paint(request, await source.exact(at, true));
	}

	$effect(() => {
		void show(seconds);
	});

	onDestroy(() => stills?.release());
</script>

<div class="relative h-full w-full bg-black">
	<canvas bind:this={canvas} class="h-full w-full"></canvas>
	{#if !painted}
		<div class="absolute inset-0 flex items-center justify-center text-white/60"><span class="loading loading-sm"></span></div>
	{:else if !exact}
		<span class="loading loading-xs absolute top-1.5 right-1.5 text-white/70" title="Loading the exact frame"></span>
	{/if}
</div>
