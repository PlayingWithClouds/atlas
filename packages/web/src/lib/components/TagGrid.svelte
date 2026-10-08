<script lang="ts">
	import type { LabelGroup } from '@atlas/contracts';
	import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
	import TagIcon from 'phosphor-svelte/lib/Tag';

	let {
		groups,
		selected,
		suggestions = {},
		threshold = 0.5,
		thumbnails = {},
		onToggle
	}: {
		groups: LabelGroup[];
		selected: Set<string>;
		/** Model probability per class name. */
		suggestions?: Record<string, number>;
		/** Probability at which a class is highlighted as suggested. */
		threshold?: number;
		/** Class name to example image URL; overrides the class's own `thumbnail`. */
		thumbnails?: Record<string, string>;
		onToggle: (name: string) => void;
	} = $props();

	// Flat position across all groups, so number keys 1-9 map to the first classes.
	const indexed = $derived.by(() => {
		let position = 0;
		return groups.map((group) => ({
			group,
			items: group.classes.map((labelClass) => ({ labelClass, index: position++ }))
		}));
	});

	function thumbnailOf(name: string, own: string | undefined): string | undefined {
		return thumbnails[name] || own;
	}
</script>

<div class="flex flex-col gap-5">
	{#each indexed as { group, items } (group.id)}
		<div>
			<div class="text-dim mb-2 text-[10px] font-semibold tracking-wider uppercase">{group.label}</div>
			<div class="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
				{#each items as { labelClass, index } (labelClass.name)}
					{@const probability = suggestions[labelClass.name]}
					{@const isSelected = selected.has(labelClass.name)}
					{@const suggested = probability !== undefined && probability >= threshold}
					{@const image = thumbnailOf(labelClass.name, labelClass.thumbnail)}
					<button
						type="button"
						onclick={() => onToggle(labelClass.name)}
						title={labelClass.info}
						class="relative flex flex-col overflow-hidden rounded-lg border text-center transition
							{isSelected ? 'border-primary ring-2 ring-primary' : suggested ? 'border-green/60' : 'border-line'}"
					>
						{#if index < 9}
							<span class="absolute top-1 left-1.5 z-10 rounded bg-black/55 px-1 font-mono text-[9px] text-white">{index + 1}</span>
						{/if}

						{#if image}
							<img src={image} alt={labelClass.name} class="aspect-[4/3] w-full object-cover" loading="lazy" />
							<div class="absolute inset-x-0 bottom-0 flex items-end justify-between gap-1 bg-gradient-to-t from-black/85 to-transparent p-1.5 pt-6">
								<span class="text-left text-[11px] leading-tight font-semibold text-white break-words">{labelClass.name}</span>
								{#if probability !== undefined}
									<span class="shrink-0 font-mono text-[10px] font-bold {suggested ? 'text-green' : 'text-white/85'}">{Math.round(probability * 100)}%</span>
								{/if}
							</div>
							{#if isSelected}
								<div class="bg-primary text-primary-content absolute top-1 right-1 rounded-full p-0.5"><CheckIcon size={11} weight="bold" /></div>
							{/if}
						{:else}
							<div class="flex flex-col items-center gap-1 px-2 py-2.5
								{isSelected ? 'bg-primary text-primary-content' : suggested ? 'bg-green-soft text-default' : 'bg-surface text-muted hover:bg-hover hover:text-default'}">
								<span class="flex h-12 items-center text-2xl leading-none">
									{#if labelClass.icon}{labelClass.icon}{:else}<TagIcon size={24} />{/if}
								</span>
								<span class="text-[11px] leading-tight font-medium break-words">{labelClass.name}</span>
								{#if probability !== undefined}
									<span class="font-mono text-[11px] font-semibold {isSelected ? 'opacity-80' : suggested ? 'text-green' : 'text-dim'}">
										{Math.round(probability * 100)}%
									</span>
								{/if}
							</div>
						{/if}
					</button>
				{/each}
			</div>
		</div>
	{/each}
</div>
