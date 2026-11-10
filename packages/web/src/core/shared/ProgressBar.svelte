<script lang="ts">
	let { labeled, skipped, total }: { labeled: number; skipped: number; total: number } = $props();

	const labeledPercent = $derived.by(() => {
		if (total === 0) {
			return 0;
		}
		return (labeled / total) * 100;
	});
	const skippedPercent = $derived.by(() => {
		if (total === 0) {
			return 0;
		}
		return (skipped / total) * 100;
	});
</script>

<div class="bg-raised flex h-1.5 w-full overflow-hidden rounded-full">
	<div class="bg-green" style="width: {labeledPercent}%"></div>
	<div class="bg-amber" style="width: {skippedPercent}%"></div>
</div>
