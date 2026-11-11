<script lang="ts">
	// Stills under the timeline, pinned to time rather than to the screen: each cell covers one
	// step of a fixed grid (powers of two seconds), so panning slides the cells along and only
	// newly visible ones load, and zooming within a step just stretches them (object-fit keeps
	// the picture right). Stills come from the thumbnail track when it is fine enough for the
	// step, else they are grabbed from the video one by one.
	import type { FilmstripProps } from '@atlas/contracts/web';
	import { onDestroy } from 'svelte';
	import type { Still } from './stills';
	import { Stills, paintNative } from './stills';

	let { asset, start, end, count }: FilmstripProps = $props();

	let stills: Stills | undefined;
	let stillsUrl = '';
	/** Loaded stills by cell key, kept while the step stays the same. */
	let cache = new Map<string, Promise<Still | undefined>>();
	let cacheStep = 0;

	interface Cell {
		key: string;
		seconds: number;
		left: number;
		width: number;
	}

	/** The smallest power-of-two step at least as long as `count` evenly spaced cells would be. */
	const step = $derived.by(() => {
		const wanted = (end - start) / Math.max(1, Math.floor(count));
		return 2 ** Math.ceil(Math.log2(Math.max(wanted, 1 / 64)));
	});

	const cells = $derived.by((): Cell[] => {
		const span = end - start;
		if (span <= 0) {
			return [];
		}
		const first = Math.floor(start / step);
		const last = Math.ceil(end / step);
		const out: Cell[] = [];
		for (let index = first; index < last; index++) {
			const cellStart = index * step;
			out.push({
				key: `${step}:${index}`,
				seconds: cellStart + step / 2,
				left: ((cellStart - start) / span) * 100,
				width: (step / span) * 100
			});
		}
		return out;
	});

	function stillsFor(): Stills {
		if (stills === undefined || stillsUrl !== asset.url) {
			stills?.release();
			stills = new Stills(asset);
			stillsUrl = asset.url;
			cache = new Map();
		}
		return stills;
	}

	async function load(source: Stills, seconds: number, owner: object): Promise<Still | undefined> {
		const fromTrack = step >= (await source.spacing()) * 0.75;
		if (fromTrack) {
			return source.quick(seconds);
		}
		return source.exact(seconds, false, owner);
	}

	function stillOf(cell: Cell, owner: object): Promise<Still | undefined> {
		const source = stillsFor();
		if (cacheStep !== step) {
			cache = new Map();
			cacheStep = step;
		}
		let known = cache.get(cell.key);
		if (known === undefined) {
			known = load(source, cell.seconds, owner);
			cache.set(cell.key, known);
		}
		return known;
	}

	/** Paints a cell once it is mounted; a cell scrolled away before its grab ran cancels it. */
	function paintCell(canvas: HTMLCanvasElement, cell: Cell) {
		const owner = {};
		let alive = true;
		void stillOf(cell, owner).then((still) => {
			if (alive && still !== undefined) {
				paintNative(canvas, still);
			}
		});
		return {
			destroy() {
				alive = false;
				stills?.cancel(owner);
				// A cancelled grab resolves empty; forget it so the cell loads again when it returns.
				void cache.get(cell.key)?.then((still) => {
					if (still === undefined) {
						cache.delete(cell.key);
					}
				});
			}
		};
	}

	onDestroy(() => {
		stills?.release();
	});
</script>

<div class="relative h-full w-full overflow-hidden">
	{#each cells as cell (cell.key)}
		<canvas
			use:paintCell={cell}
			class="absolute top-0 h-full border-r border-black/60 bg-black/40 object-contain"
			style="left: {cell.left}%; width: {cell.width}%"
			data-seconds={cell.seconds}
		></canvas>
	{/each}
</div>
