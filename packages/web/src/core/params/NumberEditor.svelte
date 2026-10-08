<script lang="ts">
	import type { NodeParam } from '@atlas/contracts';

	let { param, value, change }: { param: NodeParam; value: unknown; change: (value: unknown) => void } = $props();

	const current = $derived(Number(value));
	const hasRange = $derived(param.min !== undefined && param.max !== undefined);
</script>

{#if hasRange}
	<div class="flex items-center gap-2">
		<input
			class="min-w-0 flex-1"
			type="range"
			min={param.min}
			max={param.max}
			step={param.step === undefined ? 0.05 : param.step}
			value={current}
			oninput={(event) => change(Number(event.currentTarget.value))}
		/>
		<span class="text-default w-10 text-right text-[11px] tabular-nums">{current.toFixed(2)}</span>
	</div>
{:else}
	<input
		class="input input-sm w-full"
		type="number"
		step={param.step === undefined ? 1 : param.step}
		value={current}
		oninput={(event) => change(Number(event.currentTarget.value))}
	/>
{/if}
