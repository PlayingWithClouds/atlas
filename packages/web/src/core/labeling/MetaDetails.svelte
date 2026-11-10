<script lang="ts">
	import type { ItemDetail } from '@atlas/contracts';

	let { detail }: { detail: ItemDetail } = $props();

	function entriesOf(meta: Record<string, unknown> | undefined): [string, string][] {
		if (meta === undefined) {
			return [];
		}
		return Object.entries(meta).map(([key, value]) => [key, textOf(value)]);
	}

	function textOf(value: unknown): string {
		if (typeof value === 'string') {
			return value;
		}
		return JSON.stringify(value);
	}

	const assetEntries = $derived(entriesOf(detail.asset.meta));
	const itemEntries = $derived(entriesOf(detail.item.meta));
</script>

{#if assetEntries.length > 0 || itemEntries.length > 0}
	<details class="text-xs">
		<summary class="text-dim hover:text-default cursor-pointer select-none">Details</summary>
		<dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
			{#each [...assetEntries, ...itemEntries] as [key, value] (key + value)}
				<dt class="text-faint font-mono">{key}</dt>
				<dd class="text-muted break-all">{value}</dd>
			{/each}
		</dl>
	</details>
{/if}
