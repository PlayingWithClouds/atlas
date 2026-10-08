<script lang="ts">
	import type { NodeParam } from '@atlas/contracts';

	let { param, value, change }: { param: NodeParam; value: unknown; change: (value: unknown) => void } = $props();
</script>

<input type="checkbox" checked={Boolean(value)} onchange={(event) => change(event.currentTarget.checked)} />
