<script lang="ts">
	import { kernelContext } from '../../kernel/context';

	let { target }: { target: string } = $props();

	const ctx = kernelContext();

	$effect(() => {
		ctx.router.navigate(target, { replace: true });
	});
</script>
