<script lang="ts">
	import type { MediaPreviewProps } from '@atlas/contracts/web';

	let { asset, poster }: MediaPreviewProps = $props();

	const source = $derived.by(() => {
		if (poster !== undefined) {
			return poster;
		}
		if (asset.poster !== undefined) {
			return asset.poster;
		}
		return asset.url;
	});
</script>

<div class="bg-canvas aspect-video w-full overflow-hidden">
	<img src={source} alt="" loading="lazy" class="h-full w-full object-cover" />
</div>
