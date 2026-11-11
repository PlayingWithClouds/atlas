<script lang="ts">
	import Key from '../../lib/components/Key.svelte';
	import { KEY_HELP } from './keyboardMap';

	let { open, onclose }: { open: boolean; onclose: () => void } = $props();

	let dialog = $state<HTMLDialogElement>();

	$effect(() => {
		if (dialog === undefined) return;
		if (open && !dialog.open) {
			dialog.showModal();
		}
		if (!open && dialog.open) {
			dialog.close();
		}
	});
</script>

<dialog bind:this={dialog} class="modal" onclose={onclose}>
	<div class="modal-box max-w-xl">
		<h2 class="text-default mb-3 text-lg font-semibold">Keyboard</h2>
		<table class="w-full text-[15px]">
			<tbody>
				{#each KEY_HELP as entry (entry.action)}
					<tr class="border-line border-b last:border-b-0">
						<td class="w-40 py-1.5 pr-3 whitespace-nowrap">
							{#each entry.keys as key (key)}<Key label={key} />{/each}
						</td>
						<td class="text-muted py-1.5">{entry.action}</td>
					</tr>
				{/each}
			</tbody>
		</table>
		<p class="text-dim mt-3 text-sm">
			A group counts as reviewed while it is on screen (primary, or inside an open More groups) unless you mark it not reviewed. Suggestions are proposals only: nothing is selected until you accept it.
		</p>
		<div class="modal-action">
			<button type="button" class="btn btn-sm" onclick={onclose}>Close (Esc)</button>
		</div>
	</div>
	<button type="button" class="modal-backdrop" aria-label="Close" onclick={onclose}></button>
</dialog>
