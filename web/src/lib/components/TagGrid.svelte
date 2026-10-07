<script lang="ts">
	import { groupClasses, categoryIcon } from '$lib/labels';
	import CheckIcon from 'phosphor-svelte/lib/CheckIcon';

	let {
		classes,
		selected,
		suggestions = {},
		threshold = 0.5,
		onToggle
	}: {
		classes: string[];
		selected: Set<string>;
		suggestions?: Record<string, number>;
		threshold?: number;
		onToggle: (name: string) => void;
	} = $props();

	const groups = $derived(groupClasses(classes));
</script>

<div class="flex flex-col gap-5">
	{#each groups as group (group.group)}
		<div>
			<div class="text-dim mb-2 text-[10px] font-semibold tracking-wider uppercase">{group.label}</div>
			<div class="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
				{#each group.items as item (item.name)}
					{@const prob = suggestions[item.name]}
					{@const isSelected = selected.has(item.name)}
					{@const suggested = prob !== undefined && prob >= threshold}
					{@const img = categoryIcon(item.name)}
					<button
						type="button"
						onclick={() => onToggle(item.name)}
						title={item.info}
						class="relative flex flex-col overflow-hidden rounded-lg border text-center transition
							{isSelected ? 'border-primary ring-2 ring-primary' : suggested ? 'border-green/60' : 'border-line'}"
					>
						{#if item.index < 9}
							<span class="absolute top-1 left-1.5 z-10 rounded bg-black/55 px-1 font-mono text-[9px] text-white">{item.index + 1}</span>
						{/if}

						{#if img}
							<!-- Full-size category image with name + probability overlaid on top -->
							<img src={img} alt={item.name} class="aspect-[4/3] w-full object-cover" loading="lazy" />
							<div class="absolute inset-x-0 bottom-0 flex items-end justify-between gap-1 bg-gradient-to-t from-black/85 to-transparent p-1.5 pt-6">
								<span class="text-left text-[11px] leading-tight font-semibold text-white break-words">{item.name}</span>
								{#if prob !== undefined}
									<span class="shrink-0 font-mono text-[10px] font-bold {suggested ? 'text-green' : 'text-white/85'}">{Math.round(prob * 100)}%</span>
								{/if}
							</div>
							{#if isSelected}
								<div class="bg-primary text-primary-content absolute top-1 right-1 rounded-full p-0.5"><CheckIcon size={11} weight="bold" /></div>
							{/if}
						{:else}
							<div class="flex flex-col items-center gap-1 px-2 py-2.5
								{isSelected ? 'bg-primary text-primary-content' : suggested ? 'bg-green-soft text-default' : 'bg-surface text-muted hover:bg-hover hover:text-default'}">
								<span class="flex h-12 items-center text-2xl leading-none">{item.icon}</span>
								<span class="text-[11px] leading-tight font-medium break-words">{item.name}</span>
								{#if prob !== undefined}
									<span class="font-mono text-[11px] font-semibold {isSelected ? 'opacity-80' : suggested ? 'text-green' : 'text-dim'}">
										{Math.round(prob * 100)}%
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
