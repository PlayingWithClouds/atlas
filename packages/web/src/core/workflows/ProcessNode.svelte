<script lang="ts">
	import { getContext } from 'svelte';
	import CubeIcon from 'phosphor-svelte/lib/Cube';
	import { kernelContext } from '../../kernel/context';
	import { CATALOG_CONTEXT, type CatalogMap } from './catalog';
	import { badgeStyle, presentationFor } from './presentation';

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

	const ctx = kernelContext();
	const catalog = getContext<CatalogMap>(CATALOG_CONTEXT);
	const spec = $derived(catalog.get(kind));
	const presentation = $derived(presentationFor(ctx, kind));
	const Icon = $derived(presentation && presentation.icon ? presentation.icon : CubeIcon);

	function editorFor(paramKind: string) {
		const matching = ctx.paramEditors.list().filter((editor) => editor.kind === paramKind);
		return matching[matching.length - 1];
	}

	function valueOf(key: string, fallback: unknown): unknown {
		if (key in params) return params[key];
		return fallback;
	}

	function applyAll(next: Record<string, unknown>) {
		for (const [key, value] of Object.entries(next)) {
			onParamChange(key, value);
		}
	}
</script>

<div
	class="border-line bg-surface w-64 rounded-lg border p-3 shadow-sm transition-shadow"
	class:!border-action={selected}
	class:shadow-lg={selected}
>
	<div class="flex items-center gap-2">
		<div class="bg-action/15 text-action flex h-7 w-7 items-center justify-center rounded-md" style={badgeStyle(presentation)}>
			<Icon size={15} />
		</div>
		<div class="min-w-0">
			<div class="text-default text-sm font-semibold leading-tight">{spec ? spec.label : kind}</div>
			<div class="text-faint truncate text-[11px] leading-tight">{spec ? spec.description : ''}</div>
		</div>
	</div>

	{#if spec && presentation?.editor}
		<div class="border-line mt-2.5 border-t pt-2.5">
			<presentation.editor {spec} {params} change={applyAll} />
		</div>
	{:else if spec && spec.params.length}
		<div class="border-line mt-2.5 space-y-2 border-t pt-2.5">
			{#each spec.params as param (param.key)}
				{@const editor = editorFor(param.kind)}
				<div>
					<div class="text-dim mb-1 text-[11px] font-medium">{param.label}</div>
					{#if editor}
						<editor.component {param} value={valueOf(param.key, param.default)} change={(value) => onParamChange(param.key, value)} />
					{:else}
						<div class="text-faint text-[11px]">No editor for "{param.kind}" parameters.</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
