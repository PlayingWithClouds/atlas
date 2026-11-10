<script lang="ts">
	import type { Group, GroupKind } from '@atlas/contracts';
	import Select from '../../lib/components/Select.svelte';
	import LabelRow from './LabelRow.svelte';
	import { newLabel, uniqueId } from './taxonomyEdit';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import TrashIcon from 'phosphor-svelte/lib/Trash';

	let {
		group = $bindable(),
		allGroups,
		saved,
		savedLabelIds,
		otherGroupIds,
		onremove
	}: {
		group: Group;
		allGroups: Group[];
		saved: boolean;
		/** Label ids of this group that exist on the server; those can only be deprecated. */
		savedLabelIds: string[];
		otherGroupIds: string[];
		onremove: () => void;
	} = $props();

	const KIND_OPTIONS = [
		{ value: 'single', label: 'Single choice' },
		{ value: 'multi', label: 'Multiple choice' }
	];

	let idEdited = $state(false);

	// A condition may only point at another group that has no condition itself.
	const conditionTargets = $derived(allGroups.filter((candidate) => candidate.id !== group.id && candidate.when === undefined));
	const conditionOptions = $derived([
		{ value: '', label: 'Always asked' },
		...conditionTargets.map((target) => ({ value: target.id, label: `Only when ${target.label}…` }))
	]);
	const conditionGroupId = $derived.by(() => {
		if (group.when === undefined) {
			return '';
		}
		return group.when.group;
	});
	const labelOptions = $derived.by(() => {
		const target = allGroups.find((candidate) => candidate.id === conditionGroupId);
		if (target === undefined) {
			return [];
		}
		return target.labels.map((label) => ({ value: label.id, label: label.name }));
	});

	function onNameInput() {
		if (saved || idEdited) return;
		group.id = uniqueId(group.label, otherGroupIds);
	}

	function setPrimary(primary: boolean) {
		if (primary) {
			group.primary = true;
			return;
		}
		delete group.primary;
	}

	function setKind(kind: string) {
		group.kind = kind as GroupKind;
	}

	function setConditionGroup(groupId: string) {
		if (groupId === '') {
			delete group.when;
			return;
		}
		const target = allGroups.find((candidate) => candidate.id === groupId);
		if (target === undefined || target.labels.length === 0) return;
		group.when = { group: groupId, label: target.labels[0].id };
	}

	function setConditionLabel(labelId: string) {
		if (group.when !== undefined) {
			group.when = { group: group.when.group, label: labelId };
		}
	}

	function addLabel() {
		group.labels.push(newLabel(group));
	}

	function removeLabel(index: number) {
		group.labels.splice(index, 1);
	}

	function deprecateAll() {
		for (const label of group.labels) {
			label.deprecated = true;
		}
	}

	function siblingIdsOf(index: number): string[] {
		return group.labels.filter((_, position) => position !== index).map((label) => label.id);
	}
</script>

<section class="border-line bg-surface rounded-lg border p-4">
	<div class="mb-3 flex flex-wrap items-center gap-2">
		<input class="input w-56 font-medium" placeholder="Group name" bind:value={group.label} oninput={onNameInput} />
		<input
			class="input w-40 font-mono"
			placeholder="id"
			bind:value={group.id}
			readonly={saved}
			oninput={() => (idEdited = true)}
			title={saved ? 'Saved ids never change' : 'Stable id used in annotations'}
		/>
		<div class="w-40"><Select value={group.kind} options={KIND_OPTIONS} onChange={setKind} /></div>
		<label class="text-muted flex items-center gap-2 text-sm" title="Primary groups are shown by default; the others sit behind More groups">
			<input type="checkbox" class="toggle toggle-sm" checked={group.primary === true} onchange={(event) => setPrimary(event.currentTarget.checked)} />
			Primary
		</label>
		<div class="ml-auto flex items-center gap-1">
			{#if saved}
				<button type="button" class="btn btn-ghost btn-xs" onclick={deprecateAll} title="Groups cannot be deleted; deprecate all labels to retire one">Deprecate all</button>
			{:else}
				<button type="button" class="btn btn-ghost btn-xs btn-square" onclick={onremove} aria-label="Remove group"><TrashIcon size={14} /></button>
			{/if}
		</div>
	</div>

	<div class="mb-3 flex items-center gap-2">
		<div class="w-56"><Select value={conditionGroupId} options={conditionOptions} onChange={setConditionGroup} /></div>
		{#if group.when !== undefined}
			<div class="w-48"><Select value={group.when.label} options={labelOptions} onChange={setConditionLabel} /></div>
			<span class="text-dim text-xs">is on</span>
		{/if}
	</div>

	{#each group.labels as label, index (label)}
		<LabelRow
			bind:label={group.labels[index]}
			saved={savedLabelIds.includes(group.labels[index].id)}
			siblingIds={siblingIdsOf(index)}
			onremove={() => removeLabel(index)}
		/>
	{/each}

	<button type="button" class="btn btn-ghost btn-sm mt-1" onclick={addLabel}><PlusIcon size={13} /> Add label</button>
</section>
