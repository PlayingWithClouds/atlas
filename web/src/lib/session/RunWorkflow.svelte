<script lang="ts">
	// Run button for manual workflows, scoped to the session on screen. The command
	// menu can already do this, but a manual workflow is otherwise invisible from the
	// page it acts on — this puts it in the session header next to the run's results.
	//
	// One workflow renders as a plain button; several open a picker built from the same
	// popover shape as Select, so the header keeps one control either way.
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { listWorkflows, runWorkflow, type Workflow } from '$lib/api/workflows';
	import { pushToast } from '$lib/stores/notifications';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
	import PlayIcon from 'phosphor-svelte/lib/PlayIcon';

	let { sid }: { sid: string } = $props();

	let workflows = $state<Workflow[]>([]);
	let running = $state(false);
	let open = $state(false);
	let root = $state<HTMLElement>();
	let trigger = $state<HTMLButtonElement>();
	let triggerRect = $state<DOMRect | null>(null);
	let popoverHeight = $state(0);

	// A workflow with no triggers at all is manual by default, matching the filter the
	// command menu uses.
	const manual = $derived(
		workflows.filter((workflow) => workflow.graph && (!workflow.triggers?.length || workflow.triggers.includes('manual')))
	);

	onMount(async () => {
		try {
			workflows = (await listWorkflows($page.params.project)).workflows;
		} catch {
			// No button rather than an error: the header is not where this is fixed.
		}
	});

	const coords = $derived.by(() => {
		if (!triggerRect) return { top: 0, left: 0, width: 220 };
		const width = Math.max(triggerRect.width, 220);
		const left = Math.max(8, Math.min(triggerRect.left, window.innerWidth - width - 8));
		const below = triggerRect.bottom + 6;
		const overflowsBelow = below + popoverHeight > window.innerHeight - 8;
		const top = overflowsBelow ? Math.max(8, triggerRect.top - popoverHeight - 6) : below;
		return { top, left, width };
	});

	function toggle() {
		open = !open;
		if (open && trigger) triggerRect = trigger.getBoundingClientRect();
	}

	function summarize(workflow: Workflow): string {
		return (workflow.graph?.nodes ?? []).map((node) => node.type).join(' → ');
	}

	async function run(workflow: Workflow) {
		open = false;
		running = true;
		try {
			const result = await runWorkflow(sid, workflow.id);
			if (result.already_running) {
				notify(`"${workflow.label}" is already running on this session`, 'info');
				return;
			}
			// Progress and the finish toast arrive over the live socket from here.
			notify(`Started "${workflow.label}"`, 'success');
		} catch (error) {
			notify(`Could not start "${workflow.label}": ${error instanceof Error ? error.message : error}`, 'error');
		} finally {
			running = false;
		}
	}

	let toastCount = 0;

	function notify(message: string, level: 'info' | 'success' | 'error') {
		toastCount += 1;
		pushToast({ id: `run-${sid}-${toastCount}`, message, level, session: sid });
	}

	$effect(() => {
		if (!open) return;
		function onPointerDown(event: PointerEvent) {
			if (!root?.contains(event.target as Node)) open = false;
		}
		function onKeydown(event: KeyboardEvent) {
			if (event.key !== 'Escape') return;
			open = false;
			event.stopPropagation();
		}
		window.addEventListener('pointerdown', onPointerDown, true);
		window.addEventListener('keydown', onKeydown, true);
		return () => {
			window.removeEventListener('pointerdown', onPointerDown, true);
			window.removeEventListener('keydown', onKeydown, true);
		};
	});
</script>

{#if manual.length}
	<div bind:this={root}>
		{#if manual.length === 1}
			<button
				type="button"
				class="btn btn-sm btn-ghost"
				disabled={running}
				title={summarize(manual[0])}
				onclick={() => run(manual[0])}
			>
				<PlayIcon size={14} />
				{running ? 'Starting…' : `Run ${manual[0].label}`}
			</button>
		{:else}
			<button
				type="button"
				bind:this={trigger}
				class="btn btn-sm btn-ghost"
				disabled={running}
				aria-haspopup="menu"
				aria-expanded={open}
				onclick={toggle}
			>
				<PlayIcon size={14} />
				{running ? 'Starting…' : 'Run workflow'}
				<CaretDownIcon size={14} />
			</button>
		{/if}

		{#if open}
			<div
				bind:clientHeight={popoverHeight}
				class="border-line bg-elevated fixed z-50 max-h-64 overflow-y-auto rounded-lg border p-1 shadow-lg"
				style="top:{coords.top}px; left:{coords.left}px; width:{coords.width}px"
				role="menu"
				tabindex="-1"
			>
				{#each manual as workflow (workflow.id)}
					<button
						type="button"
						role="menuitem"
						class="hover:bg-hover flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left"
						onclick={() => run(workflow)}
					>
						<span class="text-default truncate text-sm">{workflow.label}</span>
						{#if summarize(workflow)}
							<span class="text-faint truncate text-[11px]">{summarize(workflow)}</span>
						{/if}
					</button>
				{/each}
			</div>
		{/if}
	</div>
{/if}
