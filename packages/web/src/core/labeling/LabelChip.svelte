<script lang="ts">
	import type { Label } from '@atlas/contracts';
	import Key from '../../lib/components/Key.svelte';
	import { ACCEPT_THRESHOLD, DISPLAY_THRESHOLD } from './suggestions';
	import ClockIcon from 'phosphor-svelte/lib/Clock';

	let {
		label,
		selected,
		hasRange,
		probability,
		badge,
		onclick
	}: {
		label: Label;
		selected: boolean;
		/** The label holds for part of the item (it has range bars on the timeline). */
		hasRange: boolean;
		/** The suggestion's probability, drawn as a proposal; never selected by itself. */
		probability: number | undefined;
		/** Hotkey, or the digit that reaches this label. */
		badge: string | undefined;
		onclick: () => void;
	} = $props();

	const proposed = $derived(probability !== undefined && probability >= DISPLAY_THRESHOLD && !selected);
	const strong = $derived(probability !== undefined && probability >= ACCEPT_THRESHOLD);
	const percent = $derived.by(() => {
		if (probability === undefined) {
			return '';
		}
		return `${Math.round(probability * 100)}%`;
	});

	const look = $derived.by(() => {
		if (selected) {
			return 'bg-action text-action-fg border-transparent';
		}
		if (proposed && strong) {
			return 'border-green text-default hover:bg-green-soft';
		}
		if (hasRange) {
			return 'border-violet text-default hover:bg-hover';
		}
		return 'border-line text-muted hover:text-default hover:bg-hover';
	});
</script>

<!-- Mouse-down must not move browser focus, or Space/Enter would press this button as well as the screen's shortcuts. -->
<button
	type="button"
	tabindex="-1"
	{onclick}
	onmousedown={(event) => event.preventDefault()}
	title={label.description}
	aria-pressed={selected}
	class="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm transition-colors {look} {label.deprecated ? 'opacity-60' : ''}"
>
	{#if label.image}
		<img src={label.image} alt="" loading="lazy" class="h-8 w-8 shrink-0 rounded object-cover" />
	{/if}
	<span class="leading-tight">{label.name}</span>
	{#if label.deprecated}<span class="text-faint text-[10px] uppercase">old</span>{/if}
	{#if hasRange}<ClockIcon size={12} class="text-violet" />{/if}
	{#if proposed}
		<span class="font-mono text-[11px] {strong ? 'text-green' : 'text-dim'}">{percent}</span>
	{/if}
	{#if badge}<Key label={badge} />{/if}
</button>
