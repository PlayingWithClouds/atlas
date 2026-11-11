<script lang="ts">
	import type { Label } from '@atlas/contracts';
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
		return `${Math.round(probability * 100)}`;
	});

	const look = $derived.by(() => {
		if (selected) {
			return 'bg-action text-action-fg border-transparent';
		}
		if (hasRange) {
			return 'border-violet/70 bg-violet/10 text-default hover:bg-violet/20';
		}
		if (proposed && strong) {
			return 'border-green/70 text-default hover:bg-green-soft';
		}
		return 'border-line-strong bg-raised text-default hover:bg-hover';
	});

	const tooltip = $derived.by(() => {
		const parts = [label.name];
		if (label.description) {
			parts.push(label.description);
		}
		if (hasRange) {
			parts.push('Holds for part of the item (see the timeline)');
		}
		return parts.join(' · ');
	});
</script>

<!-- Mouse-down must not move browser focus, or Space/Enter would press this button as well as the screen's shortcuts. -->
<button
	type="button"
	tabindex="-1"
	{onclick}
	onmousedown={(event) => event.preventDefault()}
	title={tooltip}
	aria-pressed={selected}
	class="flex h-9 min-w-0 items-center gap-1.5 rounded-md border px-2.5 text-left text-sm transition-colors {look} {label.deprecated ? 'opacity-60' : ''}"
>
	{#if label.image}
		<img src={label.image} alt="" loading="lazy" class="-ml-1 h-6 w-6 shrink-0 rounded object-cover" />
	{/if}
	<span class="min-w-0 flex-1 truncate">{label.name}</span>
	{#if label.deprecated}<span class="text-2xs uppercase opacity-60">old</span>{/if}
	{#if hasRange}<ClockIcon size={12} class={selected ? '' : 'text-violet'} />{/if}
	{#if proposed}
		<span class="font-mono text-2xs tabular-nums {strong ? 'text-green' : 'text-dim'}">{percent}</span>
	{/if}
	{#if badge}<span class="text-dim shrink-0 font-mono text-2xs">{badge}</span>{/if}
</button>
