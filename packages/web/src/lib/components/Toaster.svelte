<script lang="ts">
	import { kernelContext } from '../../kernel/context';

	const ctx = kernelContext();

	function accent(level: string): string {
		if (level === 'error') return 'var(--ctx-red, #f87171)';
		if (level === 'success') return 'var(--ctx-green, #34d399)';
		return 'var(--color-primary)';
	}
</script>

<div class="pointer-events-none fixed bottom-4 left-4 z-50 flex flex-col gap-2">
	{#each ctx.toastQueue.items as toast (toast.id)}
		<div
			class="border-line bg-surface pointer-events-auto flex w-72 items-start gap-2 rounded-lg border p-3 shadow-lg"
			style="border-left: 3px solid {accent(toast.level)}"
		>
			<span class="text-default flex-1 text-xs leading-snug">{toast.message}</span>
			<button type="button" class="text-faint hover:text-default text-xs" onclick={() => ctx.toastQueue.dismiss(toast.id)}>✕</button>
		</div>
	{/each}
</div>
