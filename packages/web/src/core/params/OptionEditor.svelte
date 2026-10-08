<script lang="ts">
	import type { NodeParam } from '@atlas/contracts';

	let { param, value, change }: { param: NodeParam; value: unknown; change: (value: unknown) => void } = $props();
</script>

<select class="input input-sm w-full" value={String(value)} onchange={(event) => change(event.currentTarget.value)}>
	{#each param.options || [] as option (option.value)}
		<option value={option.value}>{option.label}</option>
	{/each}
</select>
