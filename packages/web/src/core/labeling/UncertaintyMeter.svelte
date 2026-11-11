<script lang="ts">
	// How unsure the suggestion is about one group: a short bar plus its percentage.
	let { uncertainty }: { uncertainty: number } = $props();

	const UNSURE_FROM = 0.66;
	const MIXED_FROM = 0.33;

	const tone = $derived.by(() => {
		if (uncertainty >= UNSURE_FROM) {
			return { bar: 'bg-red', text: 'text-red' };
		}
		if (uncertainty >= MIXED_FROM) {
			return { bar: 'bg-amber', text: 'text-amber' };
		}
		return { bar: 'bg-green', text: 'text-green' };
	});
	const percent = $derived(Math.round(uncertainty * 100));
</script>

<span class="flex shrink-0 items-center gap-1.5" title={`The model is ${percent}% unsure about this group (0 = certain, 100 = no idea)`}>
	<span class="bg-raised h-1 w-8 overflow-hidden rounded-full">
		<span class="block h-full rounded-full {tone.bar}" style="width: {Math.max(percent, 4)}%"></span>
	</span>
	<span class="w-8 text-right font-mono text-2xs tabular-nums {tone.text}">{percent}%</span>
</span>
