<script lang="ts">
	import Key from '../../lib/components/Key.svelte';
	import { KEY_HELP } from './keyboardMap';

	const compactHelp = KEY_HELP.filter((entry) => entry.compact);
</script>

<div class="border-line text-dim flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-1.5 text-[11px]">
	{#each compactHelp as entry (entry.action)}
		<span class="flex items-center">
			{#each entry.keys as key (key)}<Key label={key} />{/each}
			<span class="ml-1.5">{entry.action}</span>
		</span>
	{/each}
</div>
