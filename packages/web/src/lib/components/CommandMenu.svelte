<script lang="ts">
	// Hotkey-driven command menu (F1 / Shift+K). Commands come from the registry; hotkeys
	// default to the contribution's `hotkey` and can be reassigned per browser.
	import type { CommandContribution } from '@atlas/contracts/web';
	import { kernelContext } from '../../kernel/context';

	const ctx = kernelContext();
	const STORAGE_KEY = 'atlas-command-hotkeys';

	let open = $state(false);
	let selectedIndex = $state(0);
	let query = $state('');
	let searchElement = $state<HTMLInputElement | null>(null);
	let rebindingId = $state<string | null>(null);
	let overrides = $state<Record<string, string>>(loadOverrides());

	function loadOverrides(): Record<string, string> {
		try {
			return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
		} catch {
			return {};
		}
	}

	function saveOverrides() {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
	}

	function hotkeyOf(command: CommandContribution): string {
		return overrides[command.id] || command.hotkey || '';
	}

	const available = $derived(ctx.commands.list().filter((command) => !command.when || command.when()));
	const filtered = $derived.by(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) return available;
		return available.filter((command) => command.label.toLowerCase().includes(needle));
	});

	function isTyping(target: EventTarget | null): boolean {
		return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
	}

	function isModifier(key: string): boolean {
		return key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta';
	}

	// Normalized key chord, e.g. "Shift+K".
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
		selectedIndex = 0;
		query = '';
		queueMicrotask(() => searchElement?.focus());
	}

	function run(command: CommandContribution) {
		open = false;
		Promise.resolve(command.run()).catch((error) => ctx.toasts.push(String(error), 'error'));
	}

	function captureHotkey(event: KeyboardEvent) {
		event.preventDefault();
		if (event.key === 'Escape') {
			rebindingId = null;
			return;
		}
		if (isModifier(event.key) || rebindingId === null) return;
		overrides = { ...overrides, [rebindingId]: combo(event) };
		saveOverrides();
		rebindingId = null;
	}

	function isSummonChord(event: KeyboardEvent): boolean {
		if (event.key === 'F1') return true;
		return event.shiftKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'k';
	}

	function onWindowKey(event: KeyboardEvent) {
		if (rebindingId) {
			captureHotkey(event);
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
		if (isSummonChord(event)) {
			event.preventDefault();
			openMenu();
			return;
		}
		const pressed = combo(event);
		const match = available.find((command) => hotkeyOf(command) === pressed);
		if (match) {
			event.preventDefault();
			run(match);
		}
	}

	function onSearchKey(event: KeyboardEvent) {
		if (rebindingId) return;
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			selectedIndex = Math.min(selectedIndex + 1, filtered.length - 1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			selectedIndex = Math.max(selectedIndex - 1, 0);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			if (filtered[selectedIndex]) run(filtered[selectedIndex]);
		}
	}

	$effect(() => {
		if (selectedIndex >= filtered.length) selectedIndex = Math.max(0, filtered.length - 1);
	});
</script>

<svelte:window onkeydown={onWindowKey} />

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]" onclick={() => (open = false)}>
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div
			class="border-line bg-surface w-full max-w-lg overflow-hidden rounded-xl border shadow-2xl"
			onclick={(event) => event.stopPropagation()}
		>
			<div class="border-line border-b p-2">
				<input
					bind:this={searchElement}
					bind:value={query}
					onkeydown={onSearchKey}
					class="input input-sm w-full"
					type="text"
					placeholder="Search commands…"
				/>
			</div>
			<div class="max-h-[50vh] overflow-y-auto p-1.5">
				{#each filtered as command, index (command.id)}
					{@const key = hotkeyOf(command)}
					<div
						class="flex w-full items-center gap-3 rounded-lg px-3 py-2 {index === selectedIndex ? 'bg-primary/15' : 'hover:bg-base-100'}"
						role="button"
						tabindex="-1"
						onmouseenter={() => (selectedIndex = index)}
						onclick={() => run(command)}
						onkeydown={(event) => event.key === 'Enter' && run(command)}
					>
						<span class="min-w-0 flex-1">
							<span class="text-default block truncate text-sm font-medium">{command.label}</span>
							{#if command.group}
								<span class="text-faint block truncate text-xs">{command.group}</span>
							{/if}
						</span>
						<button
							type="button"
							title="Click to reassign hotkey"
							class="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] {rebindingId === command.id
								? 'bg-primary text-primary-content'
								: 'bg-base-100 text-dim hover:bg-hover'}"
							onclick={(event) => {
								event.stopPropagation();
								rebindingId = command.id;
							}}
						>
							{#if rebindingId === command.id}press key…{:else if key}{key}{:else}set key{/if}
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
