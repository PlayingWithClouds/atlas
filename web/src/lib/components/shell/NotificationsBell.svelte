<script lang="ts">
	import BellIcon from 'phosphor-svelte/lib/Bell';
	import { notifications } from '$lib/stores/notifications';
	import { clearNotifications, dismissNotification } from '$lib/api/notifications';

	let open = $state(false);

	function accent(level?: string): string {
		if (level === 'error') return 'var(--ctx-red, #f87171)';
		if (level === 'success') return 'var(--ctx-green, #34d399)';
		return 'var(--color-primary)';
	}

	function dismiss(id: string) {
		dismissNotification(id).catch(() => {});
	}

	function clearAll() {
		clearNotifications().catch(() => {});
		open = false;
	}
</script>

<span class="relative inline-flex">
	<button
		type="button"
		onclick={() => (open = !open)}
		class="hover:bg-hover text-dim hover:text-default relative rounded-md p-1"
		title="Notifications"
		aria-label="Notifications"
	>
		<BellIcon size={14} />
		{#if $notifications.length}
			<span
				class="bg-primary text-primary-content absolute -top-1.5 -right-1.5 min-w-[14px] rounded-full px-1 text-center text-[9px] leading-[14px] font-semibold"
			>
				{$notifications.length}
			</span>
		{/if}
	</button>

	{#if open}
		<button type="button" class="fixed inset-0 z-10 cursor-default" aria-label="Close" onclick={() => (open = false)}></button>
		<div class="absolute -right-8 bottom-full z-20 mb-2 w-56">
			<div class="border-line bg-surface max-h-80 overflow-y-auto rounded-lg border p-1.5 shadow-xl">
				{#each $notifications as item (item.id)}
					<div class="border-line flex items-start gap-2 border-b px-2 py-2 text-xs last:border-b-0">
						<span
							class="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full"
							style="background: {accent(item.level)}"
						></span>
						<span class="text-default flex-1 leading-snug">{item.message}</span>
						<button
							type="button"
							class="text-faint hover:text-default shrink-0"
							aria-label="Dismiss"
							onclick={() => dismiss(item.id)}
						>
							✕
						</button>
					</div>
				{:else}
					<div class="text-faint px-2 py-6 text-center text-xs">No notifications</div>
				{/each}
				{#if $notifications.length > 1}
					<div class="border-line border-t px-2 pt-1.5 pb-0.5 text-right">
						<button type="button" class="text-faint hover:text-default text-[11px]" onclick={clearAll}>Clear all</button>
					</div>
				{/if}
			</div>
		</div>
	{/if}
</span>
