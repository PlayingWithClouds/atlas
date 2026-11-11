<script lang="ts">
	// Evenly spaced stills under the timeline: thumbnail-track tiles when they are fine enough for
	// the zoom, else frames grabbed one by one behind the hover preview. Moving the window (zoom,
	// pan) cancels what is still queued for the old one.
	import type { FilmstripProps } from '@atlas/contracts/web';
	import { onDestroy } from 'svelte';
	import { Stills, paintStill } from './stills';

	let { asset, start, end, count }: FilmstripProps = $props();

	let cells = $state<HTMLCanvasElement[]>([]);
	let stills: Stills | undefined;
	let stillsUrl = '';
	let owner: object = {};

	const times = $derived.by(() => {
		const safeCount = Math.max(1, Math.floor(count));
		const step = (end - start) / safeCount;
		return Array.from({ length: safeCount }, (_unused, index) => start + (index + 0.5) * step);
	});

	function stillsFor(): Stills {
		if (stills === undefined || stillsUrl !== asset.url) {
			stills?.release();
			stills = new Stills(asset);
			stillsUrl = asset.url;
		}
		return stills;
	}

	/** Track tiles do while each cell covers at least most of a tile's stretch of time. */
	async function useTrack(source: Stills, wanted: number[]): Promise<boolean> {
		const cellSeconds = (end - start) / Math.max(1, wanted.length);
		return cellSeconds >= (await source.spacing()) * 0.75;
	}

	async function fill(wanted: number[]): Promise<void> {
		const source = stillsFor();
		source.cancel(owner);
		const mine = {};
		owner = mine;
		const fromTrack = await useTrack(source, wanted);
		for (const [index, seconds] of wanted.entries()) {
			const still = await stillAt(source, seconds, fromTrack, mine);
			if (owner !== mine) {
				return;
			}
			const cell = cells[index];
			if (still !== undefined && cell !== undefined) {
				paintStill(cell, still);
			}
		}
	}

	function stillAt(source: Stills, seconds: number, fromTrack: boolean, mine: object) {
		if (fromTrack) {
			return source.quick(seconds);
		}
		return source.exact(seconds, false, mine);
	}

	$effect(() => {
		const wanted = times;
		const timer = setTimeout(() => void fill(wanted), 120);
		return () => clearTimeout(timer);
	});

	onDestroy(() => {
		stills?.cancel(owner);
		stills?.release();
	});
</script>

<div class="flex h-full w-full">
	{#each times as seconds, index (index)}
		<canvas bind:this={cells[index]} class="h-full min-w-0 flex-1 border-r border-black/60 bg-black/40" data-seconds={seconds}></canvas>
	{/each}
</div>
