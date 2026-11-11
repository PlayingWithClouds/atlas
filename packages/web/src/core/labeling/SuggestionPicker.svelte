<script lang="ts">
	// S: what the model sees at the playhead, each label running from here to where it predicts the
	// label ends. Nothing is ticked; the person picks. ↑/↓ or j/k move, Space or x ticks, Enter
	// takes the ticked ones (none ticked: the highlighted one), Esc closes.
	import { onMount } from 'svelte';
	import type { LabelingSession } from './labelingSession.svelte';
	import type { SuggestedRange } from './timeline';
	import { formatClock } from '../shared/time';

	let { session, picker }: { session: LabelingSession; picker: { time: number; ranges: SuggestedRange[] } } = $props();

	let dialog = $state<HTMLDialogElement>();
	let highlighted = $state(0);
	let ticked = $state<boolean[]>([]);

	$effect(() => {
		ticked = picker.ranges.map(() => false);
		highlighted = 0;
	});

	function nameOf(range: SuggestedRange): { group: string; label: string } {
		const group = session.taxonomy?.groups.find((candidate) => candidate.id === range.group);
		const label = group?.labels.find((candidate) => candidate.id === range.label);
		let groupName = range.group;
		if (group !== undefined) {
			groupName = group.label;
		}
		let labelName = range.label;
		if (label !== undefined) {
			labelName = label.name;
		}
		return { group: groupName, label: labelName };
	}

	function toggle(index: number) {
		ticked[index] = !ticked[index];
	}

	function take() {
		let picked = picker.ranges.filter((_, index) => ticked[index]);
		if (picked.length === 0 && picker.ranges[highlighted] !== undefined) {
			picked = [picker.ranges[highlighted]];
		}
		session.takeSuggestions(picked);
	}

	function move(offset: number) {
		const count = picker.ranges.length;
		highlighted = (highlighted + offset + count) % count;
	}

	function onKeydown(event: KeyboardEvent) {
		const handlers: Record<string, () => void> = {
			ArrowDown: () => move(1),
			j: () => move(1),
			ArrowUp: () => move(-1),
			k: () => move(-1),
			' ': () => toggle(highlighted),
			x: () => toggle(highlighted),
			Enter: take,
			Escape: () => session.closeSuggestionPicker()
		};
		const handler = handlers[event.key];
		if (handler === undefined) return;
		event.preventDefault();
		event.stopPropagation();
		handler();
	}

	onMount(() => {
		dialog?.showModal();
		return () => dialog?.close();
	});
</script>

<dialog bind:this={dialog} class="modal" onkeydown={onKeydown} oncancel={(event) => event.preventDefault()} aria-label="Suggestions at the playhead">
	<div class="modal-box max-w-lg p-0">
		<div class="border-line border-b px-5 py-3">
			<h2 class="text-default text-lg font-semibold">Suggestions at {formatClock(session.itemStart + picker.time, 2)}</h2>
			<p class="text-dim text-sm">Each runs from here to where the model sees it end.</p>
		</div>
		<ul class="max-h-[60vh] overflow-y-auto py-1">
			{#each picker.ranges as range, index (range.group + '.' + range.label)}
				{@const name = nameOf(range)}
				<li>
					<button
						type="button"
						tabindex="-1"
						onclick={() => toggle(index)}
						onmouseenter={() => (highlighted = index)}
						class="flex w-full items-center gap-3 px-5 py-2 text-left {index === highlighted ? 'bg-hover' : ''}"
					>
						<input type="checkbox" tabindex="-1" class="checkbox checkbox-sm pointer-events-none" checked={ticked[index]} />
						<span class="min-w-0 flex-1">
							<span class="text-default block truncate text-[15px] font-medium">{name.label}</span>
							<span class="text-dim block truncate text-sm">{name.group}</span>
						</span>
						<span class="text-muted shrink-0 font-mono text-sm tabular-nums">→ {formatClock(session.itemStart + range.end, 1)}</span>
						<span class="text-green w-12 shrink-0 text-right font-mono text-sm tabular-nums">{Math.round(range.score * 100)}%</span>
					</button>
				</li>
			{/each}
		</ul>
		<div class="border-line text-dim flex items-center gap-3 border-t px-5 py-3 text-sm">
			<span><kbd class="font-mono">j k</kbd> move · <kbd class="font-mono">Space</kbd> tick · <kbd class="font-mono">Enter</kbd> take · <kbd class="font-mono">Esc</kbd> close</span>
			<button type="button" class="btn btn-sm btn-primary ml-auto" onclick={take}>Take</button>
		</div>
	</div>
	<button type="button" class="modal-backdrop" aria-label="Close" onclick={() => session.closeSuggestionPicker()}></button>
</dialog>
