<script lang="ts">
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
	import CheckIcon from 'phosphor-svelte/lib/CheckIcon';

	type Option = { value: string; label: string };

	let {
		value,
		onChange,
		options,
		placeholder = 'Select',
		disabled = false
	}: {
		value: string;
		onChange: (value: string) => void;
		options: Option[];
		placeholder?: string;
		disabled?: boolean;
	} = $props();

	let open = $state(false);
	let root: HTMLElement;
	let trigger = $state<HTMLButtonElement>();
	let triggerRect = $state<DOMRect | null>(null);
	let popoverHeight = $state(0);

	const selected = $derived(options.find((option) => option.value === value));
	const triggerLabel = $derived(selected ? selected.label : placeholder);

	// Position from the live trigger rect and the measured popover height, so a
	// short list flips snugly above the trigger instead of using a fixed estimate
	// that leaves a gap near a viewport edge.
	const coords = $derived.by(() => {
		if (!triggerRect) return { top: 0, left: 0, width: 160 };
		const width = Math.max(triggerRect.width, 160);
		const left = Math.max(8, Math.min(triggerRect.left, window.innerWidth - width - 8));
		const below = triggerRect.bottom + 6;
		const overflowsBelow = below + popoverHeight > window.innerHeight - 8;
		const top = overflowsBelow ? Math.max(8, triggerRect.top - popoverHeight - 6) : below;
		return { top, left, width };
	});

	function toggle() {
		if (disabled) return;
		open = !open;
		if (open && trigger) triggerRect = trigger.getBoundingClientRect();
	}

	function pick(option: Option) {
		onChange(option.value);
		open = false;
	}

	$effect(() => {
		if (!open) return;
		function onPointerDown(event: PointerEvent) {
			if (!root.contains(event.target as Node)) open = false;
		}
		function onKeydown(event: KeyboardEvent) {
			if (event.key !== 'Escape') return;
			open = false;
			event.stopPropagation();
		}
		function onScroll(event: Event) {
			if (root.contains(event.target as Node)) return; // option-list scroll stays open
			open = false;
		}
		window.addEventListener('pointerdown', onPointerDown, true);
		window.addEventListener('keydown', onKeydown, true);
		window.addEventListener('scroll', onScroll, true);
		return () => {
			window.removeEventListener('pointerdown', onPointerDown, true);
			window.removeEventListener('keydown', onKeydown, true);
			window.removeEventListener('scroll', onScroll, true);
		};
	});
</script>

<div class="min-w-0" bind:this={root}>
	<button
		type="button"
		bind:this={trigger}
		{disabled}
		class="flex w-full items-center justify-between gap-1 rounded-lg border border-line bg-input px-3 py-2 text-sm hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-40"
		onclick={toggle}
		aria-haspopup="listbox"
		aria-expanded={open}
	>
		<span class="truncate {selected ? 'text-default' : 'text-faint'}">{triggerLabel}</span>
		<span class="shrink-0 text-muted"><CaretDownIcon size={16} /></span>
	</button>

	{#if open}
		<div
			bind:clientHeight={popoverHeight}
			class="fixed z-50 max-h-64 overflow-y-auto rounded-lg border border-line bg-elevated p-1 shadow-lg"
			style="top:{coords.top}px; left:{coords.left}px; width:{coords.width}px"
			role="listbox"
			tabindex="-1"
		>
			{#each options as option (option.value)}
				{@const active = option.value === value}
				<button
					type="button"
					role="option"
					aria-selected={active}
					class="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm {active
						? 'bg-hover font-medium text-default'
						: 'text-muted hover:bg-hover'}"
					onclick={() => pick(option)}
				>
					<span class="truncate">{option.label}</span>
					{#if active}<CheckIcon size={14} class="shrink-0 text-blue" />{/if}
				</button>
			{/each}
		</div>
	{/if}
</div>
