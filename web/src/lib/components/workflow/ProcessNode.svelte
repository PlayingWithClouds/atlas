<script lang="ts">
	import { getContext } from 'svelte';
	import {
		iconFor,
		CATALOG_CONTEXT,
		SOURCE_KIND_CONTEXT,
		type CatalogMap,
		type SourceKindGetter
	} from '$lib/workflow/catalog';
	import { INPUT_LABEL, type InputKind } from '$lib/api/workflows';

	let {
		kind,
		params,
		selected = false,
		onParamChange
	}: {
		kind: string;
		params: Record<string, unknown>;
		selected?: boolean;
		onParamChange: (key: string, value: unknown) => void;
	} = $props();

	const catalog = getContext<CatalogMap>(CATALOG_CONTEXT);
	const sourceKind = getContext<SourceKindGetter>(SOURCE_KIND_CONTEXT);
	const spec = $derived(catalog.get(kind));
	const Icon = $derived(iconFor(kind));
	// The Source node shows the input shape the workflow's triggers provide.
	const sourceLabel = $derived(
		kind === 'source' && sourceKind ? INPUT_LABEL[sourceKind() as InputKind] : ''
	);
</script>

<div
	class="border-line bg-surface w-64 rounded-lg border p-3 shadow-sm transition-shadow"
	class:!border-action={selected}
	class:shadow-lg={selected}
>
	<div class="flex items-center gap-2">
		<div class="bg-action/15 text-action flex h-7 w-7 items-center justify-center rounded-md">
			<Icon size={15} />
		</div>
		<div class="min-w-0">
			<div class="text-default text-sm font-semibold leading-tight">{spec?.label ?? kind}</div>
			<div class="text-faint truncate text-[11px] leading-tight">
				{sourceLabel || spec?.description || ''}
			</div>
		</div>
	</div>

	{#if spec && spec.params.length}
		<div class="border-line mt-2.5 space-y-2 border-t pt-2.5">
			{#each spec.params as param (param.key)}
				<div>
					<div class="text-dim mb-1 text-[11px] font-medium">{param.label}</div>
					{#if param.kind === 'number' && param.min !== undefined && param.max !== undefined}
						<div class="flex items-center gap-2">
							<input
								class="min-w-0 flex-1"
								type="range"
								min={param.min}
								max={param.max}
								step={param.step ?? 0.05}
								value={Number(params[param.key] ?? param.default)}
								oninput={(e) => onParamChange(param.key, Number(e.currentTarget.value))}
							/>
							<span class="text-default w-8 text-right text-[11px] tabular-nums">
								{Number(params[param.key] ?? param.default).toFixed(2)}
							</span>
						</div>
					{:else if param.kind === 'number'}
						<input
							class="input input-sm w-full"
							type="number"
							step={param.step ?? 1}
							value={Number(params[param.key] ?? param.default)}
							oninput={(e) => onParamChange(param.key, Number(e.currentTarget.value))}
						/>
					{:else if param.kind === 'text'}
						<textarea
							class="input h-auto w-full resize-y py-1.5 text-xs"
							rows="3"
							placeholder={param.placeholder}
							value={String(params[param.key] ?? param.default)}
							oninput={(e) => onParamChange(param.key, e.currentTarget.value)}
						></textarea>
					{:else if param.kind === 'option'}
						<select
							class="input input-sm w-full"
							value={String(params[param.key] ?? param.default)}
							onchange={(e) => onParamChange(param.key, e.currentTarget.value)}
						>
							{#each param.options ?? [] as option (option)}<option value={option}>{option}</option>{/each}
						</select>
					{:else}
						<input
							class="input input-sm w-full"
							type="text"
							placeholder={param.placeholder}
							value={String(params[param.key] ?? param.default)}
							oninput={(e) => onParamChange(param.key, e.currentTarget.value)}
						/>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
