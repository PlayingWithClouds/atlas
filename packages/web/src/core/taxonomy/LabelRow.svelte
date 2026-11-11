<script lang="ts">
	import type { Label } from '@atlas/contracts';
	import { uniqueId } from './taxonomyEdit';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDown';
	import CaretUpIcon from 'phosphor-svelte/lib/CaretUp';
	import TrashIcon from 'phosphor-svelte/lib/Trash';

	let {
		label = $bindable(),
		saved,
		siblingIds,
		onremove
	}: { label: Label; saved: boolean; siblingIds: string[]; onremove: () => void } = $props();

	let idEdited = $state(false);
	/** Shows the rarely edited fields: id, example image, deprecated or remove. */
	let open = $state(false);

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

<div class="border-line-faint border-b {label.deprecated ? 'opacity-50' : ''}">
	<div class="grid grid-cols-[2.5rem_minmax(8rem,1fr)_2fr_1.75rem_1.75rem] items-center gap-1 py-0.5">
		<input class="input input-sm input-ghost text-center font-mono" placeholder="·" maxlength="1" value={label.hotkey} oninput={onHotkeyInput} title="Hotkey" />
		<input class="input input-sm input-ghost text-default font-medium" placeholder="Name" bind:value={label.name} oninput={onNameInput} />
		<input class="input input-sm input-ghost text-muted" placeholder="Add a description" value={label.description} oninput={(event) => onOptionalInput('description', event.currentTarget.value)} />
		{#if label.image}
			<img src={label.image} alt="" loading="lazy" class="h-6 w-6 rounded object-cover" title="Example image" />
		{:else}
			<span></span>
		{/if}
		<button type="button" class="btn btn-ghost btn-xs btn-square" onclick={() => (open = !open)} aria-label="More fields" aria-expanded={open}>
			{#if open}<CaretUpIcon size={12} />{:else}<CaretDownIcon size={12} />{/if}
		</button>
	</div>

	{#if open}
		<div class="grid grid-cols-[2.5rem_minmax(8rem,1fr)_2fr_auto] items-center gap-1 pb-2">
			<span></span>
			<input
				class="input input-sm font-mono"
				placeholder="id"
				bind:value={label.id}
				readonly={saved}
				oninput={() => (idEdited = true)}
				title={saved ? 'Saved ids never change' : 'Stable id used in annotations'}
			/>
			<input class="input input-sm" placeholder="Example image URL" value={label.image} oninput={(event) => onOptionalInput('image', event.currentTarget.value)} />
			{#if saved}
				<label class="text-dim flex items-center gap-1.5 px-1 text-xs" title="Kept for old annotations, no longer offered">
					<input type="checkbox" checked={label.deprecated === true} onchange={(event) => setDeprecated(event.currentTarget.checked)} /> deprecated
				</label>
			{:else}
				<button type="button" class="btn btn-ghost btn-xs" onclick={onremove}><TrashIcon size={13} /> Remove</button>
			{/if}
		</div>
	{/if}
</div>
