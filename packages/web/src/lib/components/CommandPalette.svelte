<script lang="ts">
	import type { CommandContribution } from '@atlas/contracts/web';
	import { kernelContext } from '../../kernel/context';
	import { palette } from '../../kernel/palette.svelte';

	const ctx = kernelContext();

	let inputElement = $state<HTMLInputElement | null>(null);
	let selectedIndex = $state(0);

	const filtered = $derived.by(() => {
		const query = palette.query.trim().toLowerCase();
		const available = ctx.commands.list().filter((command) => !command.when || command.when());
		if (!query) {
			return available;
		}
		return available.filter((command) => command.label.toLowerCase().includes(query));
	});

	$effect(() => {
		if (!palette.open) return;
		selectedIndex = 0;
		queueMicrotask(() => inputElement?.focus());
	});

	function run(command: CommandContribution) {
		palette.hide();
		Promise.resolve(command.run()).catch((error) => ctx.toasts.push(String(error), 'error'));
	}

	function onKey(event: KeyboardEvent) {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			selectedIndex = Math.min(selectedIndex + 1, filtered.length - 1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			selectedIndex = Math.max(selectedIndex - 1, 0);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			if (filtered[selectedIndex]) run(filtered[selectedIndex]);
		} else if (event.key === 'Escape') {
			event.preventDefault();
			palette.hide();
		}
	}
</script>

{#if palette.open}
	<div class="fixed inset-0 z-[200] flex items-start justify-center pt-[15vh]" style="background: var(--overlay-scrim)">
		<button type="button" class="absolute inset-0 cursor-default" aria-label="Close" onclick={() => palette.hide()}></button>
		<div class="border-line bg-surface relative z-10 mx-4 w-full max-w-xl overflow-hidden rounded-xl border shadow-lg">
			<input
				bind:this={inputElement}
				bind:value={palette.query}
				onkeydown={onKey}
				placeholder="Type a command…"
				spellcheck="false"
				class="border-line text-default w-full border-b bg-transparent px-4 py-3 text-sm outline-none"
			/>
			<div class="max-h-[50vh] overflow-y-auto py-1">
				{#each filtered as command, index (command.id)}
					<button
						type="button"
						onclick={() => run(command)}
						onmousemove={() => (selectedIndex = index)}
						class="flex w-full items-center gap-3 px-4 py-2 text-left text-sm {index === selectedIndex ? 'bg-hover text-default' : 'text-muted'}"
					>
						<span class="text-faint w-16 text-[10px] font-semibold tracking-wider uppercase">{command.group}</span>
						<span class="flex-1">{command.label}</span>
					</button>
				{:else}
					<div class="text-dim px-4 py-6 text-center text-sm">No commands</div>
				{/each}
			</div>
		</div>
	</div>
{/if}
