<script lang="ts">
	import type { Project } from '@atlas/contracts';

	let { open }: { project: Project; open: (params: Record<string, unknown>) => Promise<void> } = $props();

	let path = $state('');
	let busy = $state(false);
	let error = $state('');

	async function submit() {
		const trimmed = path.trim();
		if (trimmed === '' || busy) return;
		busy = true;
		error = '';
		try {
			await open({ path: trimmed });
		} catch (failure) {
			error = failure instanceof Error ? failure.message : String(failure);
			busy = false;
		}
	}
</script>

{#if error}<div class="alert alert-error mb-4 text-sm">{error}</div>{/if}

<form class="flex max-w-xl flex-col gap-2" onsubmit={(event) => { event.preventDefault(); void submit(); }}>
	<label class="text-dim text-xs font-semibold tracking-wider uppercase" for="fs-directory-path">Folder of images</label>
	<div class="flex gap-2">
		<input id="fs-directory-path" class="input flex-1" placeholder="/absolute/path/to/folder" spellcheck="false" bind:value={path} />
		<button type="submit" class="btn btn-primary" disabled={busy || path.trim() === ''}>
			{#if busy}<span class="loading loading-xs"></span>{:else}Open{/if}
		</button>
	</div>
</form>
