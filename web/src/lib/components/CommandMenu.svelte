<script lang="ts" module>
	// One reusable command menu. Callers pass a flat list of commands; the menu
	// handles summoning (F1 or Shift+K), search, keyboard navigation, running
	// actions, and per-command hotkeys the user can reassign (persisted locally).
	export type MenuCommand = {
		title: string;
		description?: string;
		hotkey?: string;
		action: () => void;
	};
</script>

<script lang="ts">
	import { browser } from '$app/environment';

	let { commands = [] }: { commands?: MenuCommand[] } = $props();

	const STORE_KEY = 'atlas-command-hotkeys';

	let open = $state(false);
	let sel = $state(0);
	let query = $state('');
	let searchEl = $state<HTMLInputElement | null>(null);
	let rebinding = $state<string | null>(null);
	// Per-command hotkey overrides, keyed by command title.
	let overrides = $state<Record<string, string>>(loadOverrides());

	function loadOverrides(): Record<string, string> {
		if (!browser) return {};
		try {
			return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
		} catch {
			return {};
		}
	}

	function saveOverrides() {
		if (browser) localStorage.setItem(STORE_KEY, JSON.stringify(overrides));
	}

	function hotkeyOf(command: MenuCommand): string {
		return overrides[command.title] ?? command.hotkey ?? '';
	}

	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return commands;
		return commands.filter(
			(c) => c.title.toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q)
		);
	});

	function isTyping(target: EventTarget | null): boolean {
		return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
	}

	function isModifier(key: string): boolean {
		return key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta';
	}

	// A normalized, comparable representation of a key chord, e.g. "Shift+K", "G".
	function combo(event: KeyboardEvent): string {
		const parts: string[] = [];
		if (event.ctrlKey) parts.push('Ctrl');
		if (event.altKey) parts.push('Alt');
		if (event.shiftKey) parts.push('Shift');
		if (event.metaKey) parts.push('Meta');
		let key = event.key;
		if (key === ' ') key = 'Space';
		if (key.length === 1) key = key.toUpperCase();
		parts.push(key);
		return parts.join('+');
	}

	function openMenu() {
		open = true;
		sel = 0;
		query = '';
		queueMicrotask(() => searchEl?.focus());
	}

	function run(command: MenuCommand) {
		open = false;
		command.action();
	}

	function startRebind(title: string) {
		rebinding = title;
	}

	function onWindowKey(event: KeyboardEvent) {
		// Capturing a new hotkey takes priority over everything else.
		if (rebinding) {
			event.preventDefault();
			if (event.key === 'Escape') {
				rebinding = null;
				return;
			}
			if (isModifier(event.key)) return;
			overrides = { ...overrides, [rebinding]: combo(event) };
			saveOverrides();
			rebinding = null;
			return;
		}

		if (open) {
			if (event.key === 'Escape') {
				event.preventDefault();
				open = false;
			}
			return;
		}

		if (isTyping(event.target)) return;

		// Summon on F1 or Shift+K.
		if (event.key === 'F1' || (event.shiftKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'k')) {
			event.preventDefault();
			openMenu();
			return;
		}

		// Otherwise, run a command whose assigned hotkey matches this chord.
		const pressed = combo(event);
		const match = commands.find((command) => hotkeyOf(command) && hotkeyOf(command) === pressed);
		if (match) {
			event.preventDefault();
			match.action();
		}
	}

	// Navigation inside the search box.
	function onSearchKey(event: KeyboardEvent) {
		if (rebinding) return; // let the window handler capture the chord
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			sel = Math.min(sel + 1, filtered.length - 1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			sel = Math.max(sel - 1, 0);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			if (filtered[sel]) run(filtered[sel]);
		}
	}

	// Keep the selection in range as the filter narrows.
	$effect(() => {
		if (sel >= filtered.length) sel = Math.max(0, filtered.length - 1);
	});
</script>

<svelte:window onkeydown={onWindowKey} />

{#if open}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]"
		onclick={() => (open = false)}
	>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="border-line bg-surface w-full max-w-lg overflow-hidden rounded-xl border shadow-2xl"
			onclick={(event) => event.stopPropagation()}
		>
			<div class="border-line border-b p-2">
				<input
					bind:this={searchEl}
					bind:value={query}
					onkeydown={onSearchKey}
					class="input input-sm w-full"
					type="text"
					placeholder="Search commands…"
				/>
			</div>
			<div class="max-h-[50vh] overflow-y-auto p-1.5">
				{#each filtered as command, index (command.title)}
					{@const key = hotkeyOf(command)}
					<div
						class="flex w-full items-center gap-3 rounded-lg px-3 py-2 {index === sel
							? 'bg-primary/15'
							: 'hover:bg-base-100'}"
						role="button"
						tabindex="-1"
						onmouseenter={() => (sel = index)}
						onclick={() => run(command)}
					>
						<span class="min-w-0 flex-1">
							<span class="text-default block truncate text-sm font-medium">{command.title}</span>
							{#if command.description}
								<span class="text-faint block truncate text-xs">{command.description}</span>
							{/if}
						</span>
						<button
							type="button"
							title="Click to reassign hotkey"
							class="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] {rebinding === command.title
								? 'bg-primary text-primary-content'
								: 'bg-base-100 text-dim hover:bg-hover'}"
							onclick={(event) => {
								event.stopPropagation();
								startRebind(command.title);
							}}
						>
							{#if rebinding === command.title}
								press key…
							{:else if key}
								{key}
							{:else}
								set key
							{/if}
						</button>
					</div>
				{:else}
					<div class="text-faint px-3 py-6 text-center text-sm">No commands</div>
				{/each}
			</div>
			<div class="border-line text-faint border-t px-3 py-1.5 text-[11px]">
				Summon with <span class="bg-base-100 rounded px-1 font-mono">F1</span> or
				<span class="bg-base-100 rounded px-1 font-mono">⇧K</span> · click a hotkey to reassign
			</div>
		</div>
	</div>
{/if}
