<script lang="ts">
	import type { NodeParam } from '@atlas/contracts';

	let { param, value, change }: { param: NodeParam; value: unknown; change: (value: unknown) => void } = $props();
</script>

<textarea
	class="input h-auto w-full resize-y py-1.5 text-xs"
	rows="3"
	value={value === undefined || value === null ? '' : String(value)}
	oninput={(event) => change(event.currentTarget.value)}
></textarea>
