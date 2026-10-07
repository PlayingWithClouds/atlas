<script lang="ts">
	import { page } from '$app/stores';
	import { paletteOpen, paletteQuery, closePalette } from '$lib/stores/palette';
	import { buildCommands, type Command } from '$lib/commands';

	let inputEl = $state<HTMLInputElement | null>(null);
	let sel = $state(0);

	const project = $derived($page.params.project ?? 'nsfw-tags');
	const filtered = $derived.by(() => {
		const q = $paletteQuery.trim().toLowerCase();
		const all = buildCommands(project);
		return q ? all.filter((c) => c.title.toLowerCase().includes(q)) : all;
	});

	$effect(() => {
		if ($paletteOpen) {
			sel = 0;
			queueMicrotask(() => inputEl?.focus());
		}
	});

	function run(c: Command) {
		closePalette();
		c.run();
	}

	function onKey(event: KeyboardEvent) {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			sel = Math.min(sel + 1, filtered.length - 1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			sel = Math.max(sel - 1, 0);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			if (filtered[sel]) run(filtered[sel]);
		} else if (event.key === 'Escape') {
			event.preventDefault();
			closePalette();
		}
	}
</script>

{#if $paletteOpen}
	<div class="fixed inset-0 z-[200] flex items-start justify-center pt-[15vh]" style="background: var(--overlay-scrim)">
		<button type="button" class="absolute inset-0 cursor-default" aria-label="Close" onclick={closePalette}></button>
		<div class="border-line bg-surface relative z-10 mx-4 w-full max-w-xl overflow-hidden rounded-xl border shadow-lg">
			<input
				bind:this={inputEl}
				bind:value={$paletteQuery}
				onkeydown={onKey}
				placeholder="Type a command…"
				spellcheck="false"
				class="border-line text-default w-full border-b bg-transparent px-4 py-3 text-sm outline-none"
			/>
			<div class="max-h-[50vh] overflow-y-auto py-1">
				{#each filtered as c, i (c.id)}
					<button
						type="button"
						onclick={() => run(c)}
						onmousemove={() => (sel = i)}
						class="flex w-full items-center gap-3 px-4 py-2 text-left text-sm {i === sel ? 'bg-hover text-default' : 'text-muted'}"
					>
						<span class="text-faint w-16 text-[10px] font-semibold tracking-wider uppercase">{c.group}</span>
						<span class="flex-1">{c.title}</span>
					</button>
				{:else}
					<div class="text-dim px-4 py-6 text-center text-sm">No commands</div>
				{/each}
			</div>
		</div>
	</div>
{/if}
