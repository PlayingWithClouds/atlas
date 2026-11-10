<script lang="ts">
	import type { Label } from '@atlas/contracts';
	import { uniqueId } from './taxonomyEdit';
	import TrashIcon from 'phosphor-svelte/lib/Trash';

	let {
		label = $bindable(),
		saved,
		siblingIds,
		onremove
	}: { label: Label; saved: boolean; siblingIds: string[]; onremove: () => void } = $props();

	let idEdited = $state(false);

	// A new label's id follows its name until the person edits the id themselves.
	function onNameInput() {
		if (saved || idEdited) return;
		label.id = uniqueId(label.name, siblingIds);
	}

	function onHotkeyInput(event: Event & { currentTarget: HTMLInputElement }) {
		const typed = event.currentTarget.value;
		if (typed === '') {
			delete label.hotkey;
			return;
		}
		label.hotkey = typed.slice(-1);
		event.currentTarget.value = label.hotkey;
	}

	function setDeprecated(deprecated: boolean) {
		if (deprecated) {
			label.deprecated = true;
			return;
		}
		delete label.deprecated;
	}

	function onOptionalInput(field: 'image' | 'description', value: string) {
		if (value === '') {
			delete label[field];
			return;
		}
		label[field] = value;
	}
</script>

<div class="border-line grid grid-cols-[1.2fr_1fr_56px_1.4fr_1.4fr_auto] items-center gap-2 border-t py-2 {label.deprecated ? 'opacity-50' : ''}">
	<input class="input input-sm" placeholder="Name" bind:value={label.name} oninput={onNameInput} />
	<input
		class="input input-sm font-mono"
		placeholder="id"
		bind:value={label.id}
		readonly={saved}
		oninput={() => (idEdited = true)}
		title={saved ? 'Saved ids never change' : 'Stable id used in annotations'}
	/>
	<input class="input input-sm text-center font-mono" placeholder="key" maxlength="1" value={label.hotkey} oninput={onHotkeyInput} title="Hotkey" />
	<input class="input input-sm" placeholder="Example image URL" value={label.image} oninput={(event) => onOptionalInput('image', event.currentTarget.value)} />
	<input class="input input-sm" placeholder="Description" value={label.description} oninput={(event) => onOptionalInput('description', event.currentTarget.value)} />
	<div class="flex items-center gap-1">
		{#if saved}
			<label class="text-dim flex items-center gap-1.5 text-xs" title="Kept for old annotations, no longer offered">
				<input type="checkbox" checked={label.deprecated === true} onchange={(event) => setDeprecated(event.currentTarget.checked)} /> deprecated
			</label>
		{:else}
			<button type="button" class="btn btn-ghost btn-xs btn-square" onclick={onremove} aria-label="Remove label"><TrashIcon size={13} /></button>
		{/if}
	</div>
</div>
