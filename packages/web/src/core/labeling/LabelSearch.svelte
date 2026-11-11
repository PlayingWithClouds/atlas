<script lang="ts">
	// Search box over every asked label (/): ↑/↓ move, Esc closes. Enter starts the label at the
	// playhead on a video (again: drops it), else toggles it.
	import type { Group } from '@atlas/contracts';
	import { onMount } from 'svelte';
	import CheckIcon from 'phosphor-svelte/lib/Check';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';
	import { valuesOfGroup } from './draft';
	import type { LabelingSession } from './labelingSession.svelte';
	import { searchLabels } from './labelSearch';
	import type { LabelMatch } from './labelSearch';

	let { session }: { session: LabelingSession } = $props();

	let query = $state('');
	let highlighted = $state(0);
	let input = $state<HTMLInputElement>();

	const matches = $derived.by(() => {
		if (session.taxonomy === undefined) {
			return [];
		}
		return searchLabels(session.taxonomy, session.draft, query);
	});

	function isPicked(match: LabelMatch): boolean {
		return valuesOfGroup(session.draft, match.group.id).includes(match.label.id);
	}

	function groupPath(group: Group): string {
		const condition = group.when;
		if (condition === undefined || session.taxonomy === undefined) {
			return group.label;
		}
		const parent = session.taxonomy.groups.find((candidate) => candidate.id === condition.group);
		if (parent === undefined) {
			return group.label;
		}
		return `${parent.label} › ${group.label}`;
	}

	function pick(match: LabelMatch | undefined) {
		if (match === undefined) return;
		session.pickSearched(match.group, match.label.id);
	}

	function close() {
		session.searchOpen = false;
	}

	function moveHighlight(offset: number) {
		if (matches.length === 0) return;
		highlighted = (highlighted + offset + matches.length) % matches.length;
	}

	function onKeydown(event: KeyboardEvent) {
		const handlers: Record<string, () => void> = {
			ArrowDown: () => moveHighlight(1),
			ArrowUp: () => moveHighlight(-1),
			Enter: () => pick(matches[highlighted]),
			Escape: close
		};
		const handler = handlers[event.key];
		if (handler === undefined) return;
		event.preventDefault();
		event.stopPropagation();
		handler();
	}

	$effect(() => {
		void query;
		highlighted = 0;
	});

	onMount(() => input?.focus());
</script>

<div class="border-line bg-canvas border-b">
	<div class="flex items-center gap-2 px-3">
		<MagnifyingGlassIcon size={14} class="text-dim shrink-0" />
		<input
			bind:this={input}
			bind:value={query}
			onkeydown={onKeydown}
			onblur={close}
			class="text-default placeholder:text-faint h-10 min-w-0 flex-1 border-0 bg-transparent text-sm outline-none focus:ring-0"
			placeholder="Search labels…"
			aria-label="Search labels"
		/>
		<kbd class="text-faint font-mono text-[10px]">Esc</kbd>
	</div>

	{#if matches.length > 0}
		<ul class="pb-1.5">
			{#each matches as match, index (match.group.id + '/' + match.label.id)}
				<li>
					<button
						type="button"
						tabindex="-1"
						onmousedown={(event) => event.preventDefault()}
						onclick={() => pick(match)}
						onmouseenter={() => (highlighted = index)}
						class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm {index === highlighted ? 'bg-hover text-default' : 'text-muted'}"
					>
						<span class="flex w-3.5 shrink-0 justify-center">
							{#if session.isOpenRange(match.group.id, match.label.id)}
								<span class="bg-violet size-2 animate-pulse rounded-full" title="Started, waiting for ]"></span>
							{:else if isPicked(match)}
								<CheckIcon size={12} class="text-green" weight="bold" />
							{/if}
						</span>
						<span class="min-w-0 flex-1 truncate">{match.label.name}</span>
						<span class="text-faint shrink-0 truncate text-[11px]">{groupPath(match.group)}</span>
					</button>
				</li>
			{/each}
		</ul>
	{:else if query.trim() !== ''}
		<p class="text-faint px-3 pb-2.5 text-xs">No label matches “{query.trim()}”</p>
	{/if}
</div>
