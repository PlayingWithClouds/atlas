<script lang="ts">
	// The still at one moment, for the timeline's hover preview. Whatever arrives (a sprite tile from
	// the thumbnail track, instant but coarse, or an exact frame, one network seek each) is drawn when
	// it is nearer the pointer than the picture on screen. While scrubbing fast, seeks finish after the
	// pointer moved on; showing them anyway keeps the preview moving instead of frozen until it stops.
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
	/** Asset seconds the pointer is at now. */
	let wanted = 0;
	/** Asset seconds of the picture on screen, and whether it is an exact frame. */
	let shownAt: number | undefined;
	let shownExact = false;

	function stillsFor(): Stills {
		if (stills === undefined || stillsUrl !== asset.url) {
			stills?.release();
			stills = new Stills(asset);
			stillsUrl = asset.url;
			shownAt = undefined;
		}
		return stills;
	}

	/** Whether a picture of moment `at` beats the one on screen (an exact frame beats a tile as near). */
	function better(at: number, exact: boolean): boolean {
		if (shownAt === undefined) {
			return true;
		}
		const distance = Math.abs(at - wanted);
		const shownDistance = Math.abs(shownAt - wanted);
		return distance < shownDistance || (distance === shownDistance && exact && !shownExact);
	}

	function paint(source: Stills, still: Still | undefined, at: number, exact: boolean): void {
		if (source !== stills || still === undefined || !(canvas instanceof HTMLCanvasElement) || !better(at, exact)) {
			return;
		}
		paintStill(canvas, still);
		painted = true;
		shownAt = at;
		shownExact = exact;
		coarse = !exact || at !== wanted;
	}

	async function show(at: number): Promise<void> {
		wanted = at;
		const source = stillsFor();
		const exact = source.exact(at, true);
		const tile = await source.tile(at);
		if (tile !== undefined) {
			paint(source, tile.still, tile.at, false);
		}
		paint(source, await exact, at, true);
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
