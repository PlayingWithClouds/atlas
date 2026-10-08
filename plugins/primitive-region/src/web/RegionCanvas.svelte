<script lang="ts">
	import {
		INITIAL_VIEW,
		hitTest,
		hueOf,
		isLargeEnough,
		normalizeDraftBox,
		toNormalizedPoint,
		zoomAround
	} from './regionGeometry';
	import type { Box, Point, Region, RegionDraft, View } from './regionGeometry';

	const WHEEL_ZOOM_STEP = 1.12;
	const KEYPOINT_RADIUS_PIXELS = 6;

	let {
		src,
		regions,
		tool,
		selectedId,
		resetSignal,
		onCreate,
		onSelect,
		onMove,
		onToolReset
	}: {
		src: string;
		regions: Region[];
		/** "select" or the primitive id being drawn. */
		tool: string;
		selectedId: string;
		/** Changing this value resets pan and zoom (new image, or the user pressed fit). */
		resetSignal: string | number;
		onCreate: (draft: RegionDraft) => void;
		onSelect: (regionId: string) => void;
		onMove: (regionId: string, shiftX: number, shiftY: number) => void;
		onToolReset: () => void;
	} = $props();

	let width = $state(1000);
	let height = $state(1000);
	let view = $state<View>({ ...INITIAL_VIEW });
	let svgElement = $state<SVGSVGElement | null>(null);
	let viewElement = $state<SVGGElement | null>(null);

	let draftStart = $state<Point | null>(null);
	let draftEnd = $state<Point | null>(null);
	let draftPolygon = $state<Point[]>([]);
	let panFrom: { x: number; y: number } | null = null;
	let moving: { regionId: string; last: Point } | null = null;

	const draftBox = $derived<Box | null>(draftStart && draftEnd ? normalizeDraftBox(draftStart, draftEnd) : null);

	$effect(() => {
		void resetSignal;
		view = { ...INITIAL_VIEW };
		draftPolygon = [];
	});

	// The SVG viewBox uses the image's pixel size so shapes keep their aspect ratio.
	$effect(() => {
		const probe = new Image();
		probe.onload = () => {
			width = probe.naturalWidth;
			height = probe.naturalHeight;
		};
		probe.src = src;
	});

	function localPoint(event: PointerEvent | WheelEvent): Point {
		if (!svgElement || !viewElement) return [0, 0];
		const matrix = viewElement.getScreenCTM();
		if (!matrix) return [0, 0];
		const point = svgElement.createSVGPoint();
		point.x = event.clientX;
		point.y = event.clientY;
		const local = point.matrixTransform(matrix.inverse());
		return toNormalizedPoint(local.x, local.y, width, height);
	}

	function viewBoxPoint(event: WheelEvent): { x: number; y: number } {
		if (!svgElement) return { x: 0, y: 0 };
		const matrix = svgElement.getScreenCTM();
		if (!matrix) return { x: 0, y: 0 };
		const point = svgElement.createSVGPoint();
		point.x = event.clientX;
		point.y = event.clientY;
		const mapped = point.matrixTransform(matrix.inverse());
		return { x: mapped.x, y: mapped.y };
	}

	function onWheel(event: WheelEvent) {
		event.preventDefault();
		const anchor = viewBoxPoint(event);
		const factor = event.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP;
		view = zoomAround(view, anchor.x, anchor.y, factor);
	}

	function startSelectInteraction(point: Point) {
		const hit = hitTest(regions, point);
		onSelect(hit ? hit.id : '');
		if (hit) {
			moving = { regionId: hit.id, last: point };
		}
	}

	function onPointerDown(event: PointerEvent) {
		(event.target as Element).setPointerCapture?.(event.pointerId);
		if (event.button === 1 || event.shiftKey) {
			panFrom = { x: event.clientX, y: event.clientY };
			return;
		}
		const point = localPoint(event);
		if (tool === 'select') {
			startSelectInteraction(point);
		} else if (tool === 'rect') {
			draftStart = point;
			draftEnd = point;
		} else if (tool === 'keypoint') {
			onCreate({ type: 'keypoint', x: point[0], y: point[1] });
		} else if (tool === 'polygon') {
			draftPolygon = [...draftPolygon, point];
		}
	}

	function panBy(event: PointerEvent) {
		if (!panFrom || !svgElement) return;
		const bounds = svgElement.getBoundingClientRect();
		// preserveAspectRatio="meet" scales by the tighter axis.
		const unitsPerPixel = Math.max(width / bounds.width, height / bounds.height);
		view = {
			...view,
			translateX: view.translateX + (event.clientX - panFrom.x) * unitsPerPixel,
			translateY: view.translateY + (event.clientY - panFrom.y) * unitsPerPixel
		};
		panFrom = { x: event.clientX, y: event.clientY };
	}

	function onPointerMove(event: PointerEvent) {
		if (panFrom) {
			panBy(event);
			return;
		}
		const point = localPoint(event);
		if (draftStart) {
			draftEnd = point;
			return;
		}
		if (moving) {
			onMove(moving.regionId, point[0] - moving.last[0], point[1] - moving.last[1]);
			moving = { regionId: moving.regionId, last: point };
		}
	}

	function onPointerUp() {
		if (draftBox && isLargeEnough(draftBox)) {
			onCreate({ type: 'rect', ...draftBox });
		}
		draftStart = null;
		draftEnd = null;
		panFrom = null;
		moving = null;
	}

	/** Called by the workspace on Enter / the close button. */
	export function closePolygon() {
		if (draftPolygon.length >= 3) {
			onCreate({ type: 'polygon', points: draftPolygon });
		}
		draftPolygon = [];
		onToolReset();
	}

	export function cancelDraft() {
		draftPolygon = [];
		draftStart = null;
		draftEnd = null;
	}

	export function hasPolygonDraft(): boolean {
		return draftPolygon.length > 0;
	}

	function colorOf(region: Region): string {
		if (region.label === '') return 'oklch(70% 0.02 250)';
		return `oklch(68% 0.16 ${hueOf(region.label)})`;
	}

	function pointsAttribute(points: Point[]): string {
		return points.map(([x, y]) => `${x * width},${y * height}`).join(' ');
	}
</script>

<svg
	bind:this={svgElement}
	viewBox="0 0 {width} {height}"
	preserveAspectRatio="xMidYMid meet"
	class="h-full w-full touch-none select-none"
	onwheel={onWheel}
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	role="application"
	aria-label="annotation canvas"
>
	<g bind:this={viewElement} transform="translate({view.translateX} {view.translateY}) scale({view.scale})">
		<image href={src} x="0" y="0" {width} {height} />
		{#each regions as region (region.id)}
			{@const color = colorOf(region)}
			{@const isSelected = region.id === selectedId}
			{#if region.type === 'rect'}
				<rect
					x={region.x * width}
					y={region.y * height}
					width={region.w * width}
					height={region.h * height}
					fill={color}
					fill-opacity={isSelected ? 0.25 : 0.12}
					stroke={color}
					stroke-width={isSelected ? 3 : 2}
					vector-effect="non-scaling-stroke"
				/>
			{:else if region.type === 'polygon'}
				<polygon
					points={pointsAttribute(region.points)}
					fill={color}
					fill-opacity={isSelected ? 0.25 : 0.12}
					stroke={color}
					stroke-width={isSelected ? 3 : 2}
					vector-effect="non-scaling-stroke"
				/>
			{:else}
				<circle
					cx={region.x * width}
					cy={region.y * height}
					r={KEYPOINT_RADIUS_PIXELS / view.scale}
					fill={color}
					stroke="white"
					stroke-width={isSelected ? 3 : 1.5}
					vector-effect="non-scaling-stroke"
				/>
			{/if}
		{/each}
		{#if draftBox}
			<rect
				x={draftBox.x * width}
				y={draftBox.y * height}
				width={draftBox.w * width}
				height={draftBox.h * height}
				fill="none"
				stroke="white"
				stroke-width="2"
				stroke-dasharray="6 4"
				vector-effect="non-scaling-stroke"
			/>
		{/if}
		{#if draftPolygon.length > 0}
			<polyline points={pointsAttribute(draftPolygon)} fill="none" stroke="white" stroke-width="2" vector-effect="non-scaling-stroke" />
			{#each draftPolygon as point, index (index)}
				<circle cx={point[0] * width} cy={point[1] * height} r={4 / view.scale} fill="white" />
			{/each}
		{/if}
	</g>
</svg>
