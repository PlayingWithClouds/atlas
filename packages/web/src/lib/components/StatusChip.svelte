<script lang="ts">
	import type { ItemStatus } from '@atlas/contracts';

	let { status }: { status: ItemStatus } = $props();

	const classes: Record<ItemStatus, string> = {
		pending: 'badge badge-ghost',
		labeled: 'badge badge-success',
		skipped: 'badge bg-amber-soft text-amber'
	};
</script>

<span class={classes[status]}>{status}</span>
