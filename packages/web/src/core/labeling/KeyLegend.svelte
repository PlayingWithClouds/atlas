<script lang="ts">
	import type { KeyHelp } from './keyboardMap';
	import { KEY_HELP } from './keyboardMap';

	const compactHelp = KEY_HELP.filter((entry) => entry.compact);

	function wordOf(entry: KeyHelp): string {
		if (entry.short !== undefined) {
			return entry.short;
		}
		return entry.action;
	}
</script>

<div class="text-faint flex flex-wrap items-center justify-center gap-x-4 gap-y-1 px-4 py-1.5 text-[11px]">
	{#each compactHelp as entry (entry.action)}
		<span class="flex items-center gap-1" title={entry.action}>
			<span class="text-dim font-mono">{entry.keys.join(' ')}</span>
			<span>{wordOf(entry)}</span>
		</span>
	{/each}
</div>
