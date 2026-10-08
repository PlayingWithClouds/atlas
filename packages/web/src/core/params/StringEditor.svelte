<script lang="ts">
	import type { NodeParam } from '@atlas/contracts';

	let { param, value, change }: { param: NodeParam; value: unknown; change: (value: unknown) => void } = $props();
</script>

<input
	class="input input-sm w-full"
	type="text"
	value={value === undefined || value === null ? '' : String(value)}
	oninput={(event) => change(event.currentTarget.value)}
/>
