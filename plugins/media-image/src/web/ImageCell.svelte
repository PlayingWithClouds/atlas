<script lang="ts">
	import type { Item, Session } from '@atlas/contracts';
	import { kernelContext } from '@atlas/web/kernel';

	let { item, active }: { item: Item; session: Session; active: boolean } = $props();

	const ctx = kernelContext();
	const source = $derived(ctx.api.url(`/items/${item.id}/${active ? 'media' : 'thumbnail'}`));
</script>

{#if active}
	<img src={source} alt="" class="max-h-full max-w-full rounded-lg object-contain" />
{:else}
	<img src={source} alt="" class="aspect-square w-full object-cover" loading="lazy" />
{/if}
