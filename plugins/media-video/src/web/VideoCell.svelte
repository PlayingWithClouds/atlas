<script lang="ts">
	import type { Item, Session } from '@atlas/contracts';
	import { kernelContext } from '@atlas/web/kernel';
	import ClipPlayer from './ClipPlayer.svelte';
	import { playerBudget } from './playerBudget';

	let { item, session, active }: { item: Item; session: Session; active: boolean } = $props();

	const ctx = kernelContext();

	let hovered = $state(false);
	let playing = $state(false);
	let holdsSlot = false;

	const wantsPlayback = $derived(active || hovered);
	const poster = $derived(ctx.api.url(`/items/${item.id}/thumbnail`));

	function releaseSlot() {
		if (!holdsSlot) return;
		playerBudget.release();
		holdsSlot = false;
	}

	// The focused (active) item always plays; hover-play in grids shares a page-wide budget.
	$effect(() => {
		if (wantsPlayback && !holdsSlot) {
			holdsSlot = playerBudget.acquire();
		}
		if (!wantsPlayback) {
			releaseSlot();
		}
		playing = active || holdsSlot;
	});

	$effect(() => releaseSlot);
</script>

{#if active}
	<div class="h-full max-h-full w-full max-w-5xl overflow-hidden rounded-lg bg-black">
		<ClipPlayer {item} {session} active={true} fit="contain" />
	</div>
{:else}
	<div
		class="relative aspect-video w-full"
		role="presentation"
		onmouseenter={() => (hovered = true)}
		onmouseleave={() => (hovered = false)}
	>
		{#if playing}
			<ClipPlayer {item} {session} active={true} fit="cover" />
		{:else}
			<img src={poster} alt="" class="h-full w-full object-cover" loading="lazy" />
		{/if}
	</div>
{/if}
