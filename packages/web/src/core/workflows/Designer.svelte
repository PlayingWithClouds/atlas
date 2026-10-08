<script lang="ts">
	import { onMount, setContext } from 'svelte';
	import type { GraphReport, NodeSpec, TriggerSpec, WorkflowGraph } from '@atlas/contracts';
	import CubeIcon from 'phosphor-svelte/lib/Cube';
	import { kernelContext } from '../../kernel/context';
	import { messageOf } from '../shared/errors';
	import ProcessNode from './ProcessNode.svelte';
	import {
		CATALOG_CONTEXT,
		TRIGGER_SCOPE_LABEL,
		defaultParams,
		hasInput,
		hasOutput,
		inputTypeLabel,
		outputSatisfies,
		outputTypeLabel,
		portColor,
		scopeOfTrigger,
		type CatalogMap
	} from './catalog';
	import { badgeStyle, presentationFor } from './presentation';
	import FloppyDiskIcon from 'phosphor-svelte/lib/FloppyDisk';
	import XIcon from 'phosphor-svelte/lib/X';
	import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircle';
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import MinusIcon from 'phosphor-svelte/lib/Minus';
	import CornersOutIcon from 'phosphor-svelte/lib/CornersOut';

	let {
		label = $bindable(),
		triggers = $bindable(),
		graph,
		catalog,
		palette,
		triggerOptions,
		projectId,
		onSave,
		onClose
	}: {
		label: string;
		triggers: string[];
		graph: WorkflowGraph;
		catalog: NodeSpec[];
		triggerOptions: TriggerSpec[];
		// Checking a graph is project-aware: a node can be valid but not applicable to
		// the media kind this project labels.
		projectId: string;
		// What the sidebar offers, when that is narrower than the catalog: a project
		// is only shown the nodes it can run. The catalog stays complete so a graph
		// authored earlier still renders its nodes with labels, params and ports
		// instead of degrading to anonymous boxes.
		palette?: NodeSpec[];
		onSave: (label: string, triggers: string[], graph: WorkflowGraph) => void;
		onClose: () => void;
	} = $props();

	const ctx = kernelContext();
	const offered = $derived(palette === undefined ? catalog : palette);
	// The catalog is fixed for the lifetime of one editing session.
	// svelte-ignore state_referenced_locally
	const byKind: CatalogMap = new Map(catalog.map((spec) => [spec.type, spec]));
	setContext(CATALOG_CONTEXT, byKind);

	// The scope of the first selected trigger decides what the graph receives.
	const inputScope = $derived(triggers.length === 0 ? 'session' : scopeOfTrigger(triggerOptions, triggers[0]));

	let triggerMenuOpen = $state(false);

	// All selected triggers must share one scope (a workflow can't take both a whole
	// session and a single item). Once one is picked, others are locked.
	function toggleTrigger(value: string) {
		if (triggers.includes(value)) {
			triggers = triggers.filter((trigger) => trigger !== value);
			return;
		}
		triggers = [...triggers, value];
	}

	function triggerDisabled(value: string): boolean {
		if (triggers.length === 0) return false;
		return scopeOfTrigger(triggerOptions, value) !== inputScope;
	}

	// --- canvas state ---------------------------------------------------------

	type CanvasNode = {
		id: string;
		kind: string;
		params: Record<string, unknown>;
		x: number;
		y: number;
	};
	type CanvasEdge = { source: string; target: string };

	const NODE_WIDTH = 224; // fallback until the node is measured (ProcessNode's w-64 at 14px rem)
	const PORT_Y = 26; // vertical center of the node header row

	// Measured border-box widths per node id; transform scale doesn't affect
	// offsetWidth, so these are already in canvas coordinates.
	let nodeWidths = $state<Record<string, number>>({});

	function nodeWidth(nodeId: string): number {
		const width = nodeWidths[nodeId];
		if (width && width > 0) {
			return width;
		}
		return NODE_WIDTH;
	}

	// The graph prop only seeds the canvas; edits live in `nodes` and `edges`.
	// svelte-ignore state_referenced_locally
	let nodes = $state<CanvasNode[]>(
		graph.nodes.map((node) => ({
			id: node.id,
			kind: node.type,
			params: node.params === undefined ? paramsFor(node.type) : node.params,
			x: node.position.x,
			y: node.position.y
		}))
	);
	// svelte-ignore state_referenced_locally
	let edges = $state<CanvasEdge[]>(
		graph.edges.map((edge) => ({ source: edge.source, target: edge.target }))
	);

	// Node ids are `${kind}-${n}`. Seed the counter past the highest existing
	// suffix so a fresh drop can never reuse an id already in the graph.
	// svelte-ignore state_referenced_locally
	let counter = $state(maxNodeSuffix(graph.nodes.map((node) => node.id)));

	let view = $state({ x: 60, y: 60, scale: 1 });
	let canvasElement = $state<HTMLDivElement>();

	let selectedNode = $state<string | null>(null);
	let selectedEdge = $state<string | null>(null);
	let menu = $state<{ x: number; y: number; id: string } | null>(null);
	let hovered = $state<{ spec: NodeSpec; x: number; y: number } | null>(null);
	let portTip = $state<{ text: string; x: number; y: number } | null>(null);

	// Interaction state: at most one of these is active at a time.
	let panning = $state<{ startX: number; startY: number; viewX: number; viewY: number } | null>(null);
	let dragging = $state<{ id: string; offsetX: number; offsetY: number } | null>(null);
	let connecting = $state<{ source: string; x: number; y: number } | null>(null);

	// Nodes a connection from the current source may land on.
	const validTargets = $derived(connectableFrom(connecting?.source));

	function connectableFrom(sourceId: string | undefined): Set<string> {
		const valid = new Set<string>();
		if (!sourceId) return valid;
		const sourceSpec = specOf(sourceId);
		if (!sourceSpec || !hasOutput(sourceSpec)) return valid;
		for (const node of nodes) {
			if (node.id === sourceId) continue;
			const targetSpec = byKind.get(node.kind);
			if (!targetSpec || !hasInput(targetSpec)) continue;
			if (outputSatisfies(sourceSpec, targetSpec)) valid.add(node.id);
		}
		return valid;
	}

	function specOf(nodeId: string): NodeSpec | undefined {
		const found = nodes.find((node) => node.id === nodeId);
		if (!found) return undefined;
		return byKind.get(found.kind);
	}

	function nodeById(nodeId: string): CanvasNode | undefined {
		return nodes.find((node) => node.id === nodeId);
	}

	function paramsFor(kind: string): Record<string, unknown> {
		const spec = byKind.get(kind);
		return spec ? defaultParams(spec) : {};
	}

	function maxNodeSuffix(ids: string[]): number {
		let max = 0;
		for (const id of ids) {
			const match = /-(\d+)$/.exec(id);
			if (match) {
				max = Math.max(max, Number(match[1]));
			}
		}
		return max;
	}

	function edgeKey(edge: CanvasEdge): string {
		return `${edge.source}__${edge.target}`;
	}

	// --- coordinate transforms --------------------------------------------------

	function toCanvas(clientX: number, clientY: number): { x: number; y: number } {
		const rect = canvasElement!.getBoundingClientRect();
		return {
			x: (clientX - rect.left - view.x) / view.scale,
			y: (clientY - rect.top - view.y) / view.scale
		};
	}

	function outPort(node: CanvasNode): { x: number; y: number } {
		return { x: node.x + nodeWidth(node.id), y: node.y + PORT_Y };
	}

	function inPort(node: CanvasNode): { x: number; y: number } {
		return { x: node.x, y: node.y + PORT_Y };
	}

	function edgePath(edge: CanvasEdge): string {
		const source = nodeById(edge.source);
		const target = nodeById(edge.target);
		if (!source || !target) return '';
		const from = outPort(source);
		const to = inPort(target);
		return bezier(from.x, from.y, to.x, to.y);
	}

	function bezier(fromX: number, fromY: number, toX: number, toY: number): string {
		const bend = Math.max(40, Math.abs(toX - fromX) / 2);
		return `M ${fromX} ${fromY} C ${fromX + bend} ${fromY}, ${toX - bend} ${toY}, ${toX} ${toY}`;
	}

	// --- pan / zoom --------------------------------------------------------------

	function onCanvasPointerDown(event: PointerEvent) {
		menu = null;
		triggerMenuOpen = false;
		// Pan when grabbing the empty canvas (left button) or with the middle button.
		if (event.button === 1 || event.target === event.currentTarget) {
			selectedNode = null;
			selectedEdge = null;
			panning = { startX: event.clientX, startY: event.clientY, viewX: view.x, viewY: view.y };
		}
	}

	function onWheel(event: WheelEvent) {
		event.preventDefault();
		const rect = canvasElement!.getBoundingClientRect();
		const pointerX = event.clientX - rect.left;
		const pointerY = event.clientY - rect.top;
		const factor = Math.exp(-event.deltaY * 0.0012);
		const nextScale = Math.min(2, Math.max(0.25, view.scale * factor));
		const ratio = nextScale / view.scale;
		view.x = pointerX - (pointerX - view.x) * ratio;
		view.y = pointerY - (pointerY - view.y) * ratio;
		view.scale = nextScale;
	}

	function zoomBy(factor: number) {
		const rect = canvasElement!.getBoundingClientRect();
		const centerX = rect.width / 2;
		const centerY = rect.height / 2;
		const nextScale = Math.min(2, Math.max(0.25, view.scale * factor));
		const ratio = nextScale / view.scale;
		view.x = centerX - (centerX - view.x) * ratio;
		view.y = centerY - (centerY - view.y) * ratio;
		view.scale = nextScale;
	}

	function fitView() {
		if (!nodes.length || !canvasElement) return;
		const padding = 80;
		const nodeHeight = 140; // generous estimate; exact fit isn't needed
		const minX = Math.min(...nodes.map((node) => node.x));
		const maxX = Math.max(...nodes.map((node) => node.x + nodeWidth(node.id)));
		const minY = Math.min(...nodes.map((node) => node.y));
		const maxY = Math.max(...nodes.map((node) => node.y + nodeHeight));
		const rect = canvasElement.getBoundingClientRect();
		const fitScale = Math.min(
			(rect.width - padding * 2) / Math.max(1, maxX - minX),
			(rect.height - padding * 2) / Math.max(1, maxY - minY)
		);
		view.scale = Math.min(1.25, Math.max(0.25, fitScale));
		view.x = (rect.width - (maxX - minX) * view.scale) / 2 - minX * view.scale;
		view.y = (rect.height - (maxY - minY) * view.scale) / 2 - minY * view.scale;
	}

	onMount(fitView);

	// --- node dragging + selection ------------------------------------------------

	function onNodePointerDown(event: PointerEvent, node: CanvasNode) {
		if (event.button !== 0) return;
		const target = event.target as HTMLElement;
		if (target.closest('input,select,textarea,button,[data-port]')) return;
		event.stopPropagation();
		selectedNode = node.id;
		selectedEdge = null;
		menu = null;
		const point = toCanvas(event.clientX, event.clientY);
		dragging = { id: node.id, offsetX: point.x - node.x, offsetY: point.y - node.y };
	}

	function onWindowPointerMove(event: PointerEvent) {
		if (panning) {
			view.x = panning.viewX + (event.clientX - panning.startX);
			view.y = panning.viewY + (event.clientY - panning.startY);
			return;
		}
		if (dragging) {
			const node = nodeById(dragging.id);
			if (node) {
				const point = toCanvas(event.clientX, event.clientY);
				node.x = point.x - dragging.offsetX;
				node.y = point.y - dragging.offsetY;
			}
			return;
		}
		if (connecting) {
			const point = toCanvas(event.clientX, event.clientY);
			connecting.x = point.x;
			connecting.y = point.y;
		}
	}

	function onWindowPointerUp(event: PointerEvent) {
		if (connecting) {
			finishConnection(event);
		}
		panning = null;
		dragging = null;
	}

	// --- connections ---------------------------------------------------------------

	function startConnection(event: PointerEvent, node: CanvasNode) {
		if (event.button !== 0) return;
		event.stopPropagation();
		event.preventDefault();
		portTip = null;
		const point = toCanvas(event.clientX, event.clientY);
		connecting = { source: node.id, x: point.x, y: point.y };
	}

	function finishConnection(event: PointerEvent) {
		const active = connecting;
		connecting = null;
		if (!active) return;
		const element = document.elementFromPoint(event.clientX, event.clientY);
		const nodeElement = element?.closest('[data-node]');
		const targetId = nodeElement?.getAttribute('data-node');
		// Recompute from the source: `validTargets` derives from `connecting`,
		// which is already cleared here.
		if (!targetId || !connectableFrom(active.source).has(targetId)) return;
		if (edges.some((edge) => edge.source === active.source && edge.target === targetId)) return;
		edges.push({ source: active.source, target: targetId });
	}

	// --- tooltips --------------------------------------------------------------------

	function showTooltip(event: MouseEvent, spec: NodeSpec) {
		const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
		hovered = { spec, x: rect.right + 10, y: rect.top };
	}

	function showPortTip(event: PointerEvent, text: string) {
		const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
		portTip = { text, x: rect.left + rect.width / 2, y: rect.top - 8 };
	}

	// --- editing -----------------------------------------------------------------------

	function onDragStart(event: DragEvent, kind: string) {
		event.dataTransfer?.setData('application/atlas-node', kind);
	}

	function onDrop(event: DragEvent) {
		event.preventDefault();
		const kind = event.dataTransfer?.getData('application/atlas-node');
		if (!kind) return;
		const point = toCanvas(event.clientX, event.clientY);
		counter += 1;
		nodes.push({ id: `${kind}-${counter}`, kind, params: paramsFor(kind), x: point.x, y: point.y });
	}

	function deleteNode(id: string) {
		nodes = nodes.filter((node) => node.id !== id);
		edges = edges.filter((edge) => edge.source !== id && edge.target !== id);
		if (selectedNode === id) selectedNode = null;
		menu = null;
	}

	function deleteSelection() {
		if (selectedEdge) {
			edges = edges.filter((edge) => edgeKey(edge) !== selectedEdge);
			selectedEdge = null;
			return;
		}
		if (selectedNode) {
			deleteNode(selectedNode);
		}
	}

	function onKeyDown(event: KeyboardEvent) {
		if (event.key !== 'Delete' && event.key !== 'Backspace') return;
		const target = event.target as HTMLElement;
		if (target.closest('input,select,textarea')) return;
		deleteSelection();
	}

	function onNodeContextMenu(event: MouseEvent, node: CanvasNode) {
		event.preventDefault();
		event.stopPropagation();
		menu = { x: event.clientX, y: event.clientY, id: node.id };
	}

	function currentGraph(): WorkflowGraph {
		return {
			nodes: nodes.map((node) => ({
				id: node.id,
				type: node.kind,
				params: node.params,
				position: { x: node.x, y: node.y }
			})),
			edges: edges.map((edge) => ({ source: edge.source, target: edge.target }))
		};
	}

	function save() {
		onSave(label, triggers, currentGraph());
	}

	let checking = $state(false);
	let report = $state<GraphReport | null>(null);

	async function check() {
		checking = true;
		try {
			report = await ctx.api.post<GraphReport>('/workflows/validate', { graph: currentGraph(), projectId });
		} catch (error) {
			report = { ok: false, errors: [messageOf(error)], warnings: [] };
		} finally {
			checking = false;
		}
	}
</script>

<svelte:window
	onclick={() => {
		menu = null;
		triggerMenuOpen = false;
	}}
	onpointermove={onWindowPointerMove}
	onpointerup={onWindowPointerUp}
	onkeydown={onKeyDown}
/>

<div class="flex h-full flex-col">
	<div class="border-line flex items-center gap-3 border-b px-4 py-2.5">
		<input class="input input-sm w-56" type="text" bind:value={label} placeholder="Workflow name" />
		<div class="relative">
			<button
				type="button"
				class="input input-sm flex w-56 items-center gap-1.5 text-left"
				onclick={(event) => {
					event.stopPropagation();
					triggerMenuOpen = !triggerMenuOpen;
				}}
			>
				<span class="text-dim text-xs">Triggers:</span>
				<span class="text-default truncate text-xs">
					{triggers.length ? `${triggers.length} selected` : 'Manual'}
				</span>
				<span class="text-faint ml-auto text-[10px]">{TRIGGER_SCOPE_LABEL[inputScope]}</span>
			</button>
			{#if triggerMenuOpen}
				<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
				<div
					class="border-line bg-surface absolute z-50 mt-1 w-64 rounded-md border p-1 shadow-lg"
					onclick={(event) => event.stopPropagation()}
				>
					{#each triggerOptions as option (option.id)}
						{@const disabled = triggerDisabled(option.id)}
						<label
							class="hover:bg-hover flex items-center gap-2 rounded px-2 py-1.5 text-xs {disabled
								? 'cursor-not-allowed opacity-40'
								: 'cursor-pointer'}"
						>
							<input
								type="checkbox"
								checked={triggers.includes(option.id)}
								{disabled}
								onchange={() => toggleTrigger(option.id)}
							/>
							<span class="text-default flex-1">{option.label}</span>
							<span class="text-faint text-[10px]">{TRIGGER_SCOPE_LABEL[option.scope]}</span>
						</label>
					{/each}
				</div>
			{/if}
		</div>
		<div class="flex-1"></div>
		<button type="button" class="btn btn-sm" onclick={check} disabled={checking}>
			<CheckCircleIcon size={14} /> Check
		</button>
		<button type="button" class="btn btn-sm" onclick={onClose}><XIcon size={14} /> Cancel</button>
		<button type="button" class="btn btn-sm btn-primary" onclick={save} disabled={!label.trim()}>
			<FloppyDiskIcon size={14} /> Save
		</button>
	</div>

	{#if report}
		<div class="border-line flex items-start gap-3 border-b px-4 py-2 text-xs">
			{#if report.ok && report.warnings.length === 0}
				<span class="text-green">This workflow is wired correctly.</span>
			{:else}
				<div class="flex-1 space-y-1">
					{#each report.errors as problem (problem)}
						<div class="text-red">{problem}</div>
					{/each}
					{#each report.warnings as warning (warning)}
						<div class="text-amber">{warning}</div>
					{/each}
				</div>
			{/if}
			<button type="button" class="text-dim hover:text-default ml-auto" onclick={() => (report = null)}>
				<XIcon size={12} />
			</button>
		</div>
	{/if}

	<div class="flex min-h-0 flex-1">
		<aside class="border-line bg-surface w-52 shrink-0 overflow-y-auto border-r p-3">
			<div class="text-dim mb-1 text-xs font-semibold uppercase tracking-wide">Nodes</div>
			<div class="text-faint mb-3 text-[11px]">Drag onto the canvas</div>
			<div class="space-y-2">
				{#each offered as spec (spec.type)}
					{@const presentation = presentationFor(ctx, spec.type)}
					{@const Icon = presentation && presentation.icon ? presentation.icon : CubeIcon}
					<div
						class="border-line bg-raised hover:border-line-strong flex cursor-grab items-center gap-2 rounded-md border p-2 active:cursor-grabbing"
						draggable="true"
						ondragstart={(event) => onDragStart(event, spec.type)}
						onmouseenter={(event) => showTooltip(event, spec)}
						onmouseleave={() => (hovered = null)}
						role="button"
						tabindex="0"
					>
						<div class="bg-action/15 text-action flex h-6 w-6 items-center justify-center rounded" style={badgeStyle(presentation)}>
							<Icon size={13} />
						</div>
						<div class="min-w-0 flex-1">
							<div class="text-default text-xs font-medium leading-tight">{spec.label}</div>
							<div class="text-faint truncate text-[10px] leading-tight">{spec.description}</div>
						</div>
					</div>
				{/each}
			</div>
		</aside>

		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			bind:this={canvasElement}
			class="relative min-w-0 flex-1 overflow-hidden {panning ? 'cursor-grabbing' : 'cursor-grab'}"
			style="touch-action:none;background-image:radial-gradient(var(--grid-dot-bold) 1px, transparent 1px);background-size:{22 *
				view.scale}px {22 * view.scale}px;background-position:{view.x}px {view.y}px"
			ondrop={onDrop}
			ondragover={(event) => event.preventDefault()}
			onpointerdown={onCanvasPointerDown}
			onwheel={onWheel}
		>
			<div
				class="absolute left-0 top-0 origin-top-left"
				style="transform:translate({view.x}px, {view.y}px) scale({view.scale})"
			>
				<svg class="pointer-events-none absolute left-0 top-0" style="overflow:visible" width="1" height="1">
					{#each edges as edge (edgeKey(edge))}
						{@const path = edgePath(edge)}
						<path
							d={path}
							fill="none"
							stroke={selectedEdge === edgeKey(edge) ? 'var(--color-action)' : 'var(--color-line)'}
							stroke-width={selectedEdge === edgeKey(edge) ? 2.5 : 2}
						/>
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<path
							d={path}
							fill="none"
							stroke="transparent"
							stroke-width="14"
							style="pointer-events:stroke;cursor:pointer"
							onpointerdown={(event) => event.stopPropagation()}
							onclick={(event) => {
								event.stopPropagation();
								selectedEdge = edgeKey(edge);
								selectedNode = null;
							}}
						/>
					{/each}
					{#if connecting}
						{@const sourceNode = nodeById(connecting.source)}
						{#if sourceNode}
							{@const from = outPort(sourceNode)}
							<path
								d={bezier(from.x, from.y, connecting.x, connecting.y)}
								fill="none"
								stroke="var(--color-action)"
								stroke-width="2"
								stroke-dasharray="6 4"
							/>
						{/if}
					{/if}
				</svg>

				{#each nodes as node (node.id)}
					{@const spec = byKind.get(node.kind)}
					{@const dimmed = connecting !== null && hasInput(spec) && !validTargets.has(node.id)}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="absolute {dragging?.id === node.id ? 'cursor-grabbing' : 'cursor-grab'}"
						style="left:{node.x}px;top:{node.y}px"
						data-node={node.id}
						bind:offsetWidth={nodeWidths[node.id]}
						onpointerdown={(event) => onNodePointerDown(event, node)}
						oncontextmenu={(event) => onNodeContextMenu(event, node)}
					>
						<ProcessNode
							kind={node.kind}
							params={node.params}
							selected={selectedNode === node.id}
							onParamChange={(key, value) => {
								node.params[key] = value;
							}}
						/>
						{#if spec && hasInput(spec)}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								data-port
								class="absolute rounded-full border-2 transition-opacity"
								class:opacity-25={dimmed}
								style="left:-6px;top:{PORT_Y - 6}px;width:12px;height:12px;background:{portColor(
									spec.input
								)};border-color:var(--color-canvas)"
								onpointerenter={(event) => showPortTip(event, `in: ${inputTypeLabel(spec)}`)}
								onpointerleave={() => (portTip = null)}
							></div>
						{/if}
						{#if spec && hasOutput(spec)}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								data-port
								class="absolute cursor-crosshair rounded-full border-2"
								style="right:-6px;top:{PORT_Y - 6}px;width:12px;height:12px;background:{portColor(
									spec.output
								)};border-color:var(--color-canvas)"
								onpointerdown={(event) => startConnection(event, node)}
								onpointerenter={(event) => showPortTip(event, `out: ${outputTypeLabel(spec)}`)}
								onpointerleave={() => (portTip = null)}
							></div>
						{/if}
					</div>
				{/each}
			</div>

			<div class="border-line bg-surface absolute bottom-3 left-3 z-40 flex flex-col rounded-md border shadow-sm">
				<button type="button" class="text-default hover:bg-hover p-1.5" title="Zoom in" onclick={() => zoomBy(1.2)}>
					<PlusIcon size={13} />
				</button>
				<button type="button" class="text-default hover:bg-hover p-1.5" title="Zoom out" onclick={() => zoomBy(1 / 1.2)}>
					<MinusIcon size={13} />
				</button>
				<button type="button" class="text-default hover:bg-hover p-1.5" title="Fit view" onclick={fitView}>
					<CornersOutIcon size={13} />
				</button>
			</div>

			{#if portTip}
				<div
					class="border-line bg-surface text-default pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border px-2 py-1 text-[11px] shadow-lg"
					style="left:{portTip.x}px;top:{portTip.y}px"
				>
					{portTip.text}
				</div>
			{/if}

			{#if hovered}
				{@const spec = hovered.spec}
				<div
					class="border-line bg-surface pointer-events-none fixed z-50 w-64 rounded-md border p-3 shadow-lg"
					style="left:{hovered.x}px;top:{hovered.y}px"
				>
					<div class="text-default mb-1 text-sm font-semibold">{spec.label}</div>
					<div class="text-dim mb-2 text-xs leading-snug">{spec.description}</div>
					<div class="text-faint space-y-1 text-[11px]">
						<div class="flex items-center gap-1.5">
							<span class="w-6 shrink-0">in</span>
							<span class="bg-raised rounded px-1 py-0.5">{inputTypeLabel(spec)}</span>
						</div>
						<div class="flex items-center gap-1.5">
							<span class="w-6 shrink-0">out</span>
							<span class="bg-raised rounded px-1 py-0.5">{outputTypeLabel(spec)}</span>
						</div>
					</div>
					<div class="text-faint mt-1.5 text-[10px] uppercase tracking-wide">
						Plugin · {spec.plugin}
					</div>
				</div>
			{/if}

			{#if menu}
				<div
					class="border-line bg-surface fixed z-50 min-w-32 rounded-md border py-1 shadow-lg"
					style="left:{menu.x}px;top:{menu.y}px"
				>
					<button
						type="button"
						class="text-error hover:bg-hover flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs"
						onclick={() => menu && deleteNode(menu.id)}
					>
						<TrashIcon size={13} /> Delete node
					</button>
				</div>
			{/if}
		</div>
	</div>
</div>
