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

<section class="flex flex-col gap-6">
	<div class="flex items-start gap-3">
		<div class="min-w-0 flex-1">
			<input class="input input-ghost text-default -ml-2 h-10 text-lg font-semibold" placeholder="Group name" bind:value={group.label} oninput={onNameInput} />
			<div class="text-faint flex items-center gap-1 text-xs">
				<span>id</span>
				<input
					class="input input-sm input-ghost text-dim h-6 w-48 font-mono"
					placeholder="id"
					bind:value={group.id}
					readonly={saved}
					oninput={() => (idEdited = true)}
					title={saved ? 'Saved ids never change' : 'Stable id used in annotations'}
				/>
			</div>
		</div>
		{#if saved}
			<button type="button" class="btn btn-ghost btn-sm" onclick={deprecateAll} title="Groups cannot be deleted; deprecate all labels to retire one">Deprecate all</button>
		{:else}
			<button type="button" class="btn btn-ghost btn-sm" onclick={onremove}><TrashIcon size={14} /> Remove group</button>
		{/if}
	</div>

	<dl class="grid grid-cols-[7rem_1fr] items-center gap-x-4 gap-y-3 text-sm">
		<dt class="text-dim">Answer</dt>
		<dd class="w-48"><Select value={group.kind} options={KIND_OPTIONS} onChange={setKind} /></dd>

		<dt class="text-dim">Asked</dt>
		<dd class="flex flex-wrap items-center gap-2">
			<div class="w-56"><Select value={conditionGroupId} options={conditionOptions} onChange={setConditionGroup} /></div>
			{#if group.when !== undefined}
				<div class="w-48"><Select value={group.when.label} options={labelOptions} onChange={setConditionLabel} /></div>
				<span class="text-dim text-xs">is on</span>
			{/if}
		</dd>

		<dt class="text-dim">Primary</dt>
		<dd>
			<label class="text-muted flex items-center gap-2 text-sm">
				<input type="checkbox" class="toggle toggle-sm" checked={group.primary === true} onchange={(event) => setPrimary(event.currentTarget.checked)} />
				<span class="text-faint text-xs">Shown by default; otherwise behind "More groups"</span>
			</label>
		</dd>
	</dl>

	<div>
		<div class="text-faint border-line grid grid-cols-[2.5rem_minmax(8rem,1fr)_2fr_1.75rem_1.75rem] gap-1 border-b pb-1.5 text-2xs font-medium tracking-wide uppercase">
			<span class="text-center">Key</span>
			<span class="px-2">Label · {group.labels.length}</span>
			<span class="px-2">Description</span>
		</div>
		{#each group.labels as label, index (label)}
			<LabelRow
				bind:label={group.labels[index]}
				saved={savedLabelIds.includes(group.labels[index].id)}
				siblingIds={siblingIdsOf(index)}
				onremove={() => removeLabel(index)}
			/>
		{/each}
		<button type="button" class="btn btn-ghost btn-sm mt-2" onclick={addLabel}><PlusIcon size={13} /> Add label</button>
	</div>
</section>
