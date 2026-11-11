<script lang="ts">
	// The still at one moment, for the timeline's hover preview. The last exact frame stays on screen
	// until the next one is grabbed; the thumbnail track's coarse tile is only shown when the pointer
	// jumped further than a tile spans (or nothing is on screen yet), so scrubbing never flickers.
	// Stale answers are dropped so the picture always belongs to the latest position.
	import type { FramePreviewProps } from '@atlas/contracts/web';
	import { onDestroy } from 'svelte';
	import { Stills, paintStill } from './stills';
	import type { Still } from './stills';

	let { asset, seconds }: FramePreviewProps = $props();

	let canvas = $state<HTMLCanvasElement>();
	let painted = $state(false);
	let coarse = $state(false);
	let stills: Stills | undefined;
	let stillsUrl = '';
	let latest = 0;
	/** Asset seconds of the exact frame on screen. */
	let exactAt: number | undefined;

	function stillsFor(): Stills {
		if (stills === undefined || stillsUrl !== asset.url) {
			stills?.release();
			stills = new Stills(asset);
			stillsUrl = asset.url;
			exactAt = undefined;
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

	/** The coarse tile helps only when the exact frame on screen is further away than a tile spans. */
	async function wantsCoarse(source: Stills, at: number): Promise<boolean> {
		if (exactAt === undefined) {
			return true;
		}
		return Math.abs(at - exactAt) > (await source.spacing());
	}

	async function show(at: number): Promise<void> {
		latest += 1;
		const request = latest;
		const source = stillsFor();
		const exact = source.exact(at, true);
		if (await wantsCoarse(source, at)) {
			if (paint(request, await source.quick(at))) {
				coarse = true;
			}
		}
		if (paint(request, await exact)) {
			exactAt = at;
			coarse = false;
		}
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
	{:else if coarse}
		<span class="loading loading-xs absolute top-1.5 right-1.5 text-white/70" title="Loading the exact frame"></span>
	{/if}
</div>
