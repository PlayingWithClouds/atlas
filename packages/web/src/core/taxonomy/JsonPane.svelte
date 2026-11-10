<script lang="ts">
	import type { Group } from '@atlas/contracts';
	import { kernelContext } from '../../kernel/context';
	import { parseTaxonomyJson, taxonomyToJson } from './taxonomyEdit';
	import CopyIcon from 'phosphor-svelte/lib/Copy';
	import DownloadSimpleIcon from 'phosphor-svelte/lib/DownloadSimple';
	import UploadSimpleIcon from 'phosphor-svelte/lib/UploadSimple';

	let { groups, onapply }: { groups: Group[]; onapply: (groups: Group[]) => void } = $props();

	const ctx = kernelContext();

	// Seeded once when the tab opens; later edits of the groups do not overwrite what is being typed.
	// svelte-ignore state_referenced_locally
	let text = $state(taxonomyToJson($state.snapshot(groups)));
	let problems = $state<string[]>([]);

	function apply() {
		const parsed = parseTaxonomyJson(text);
		problems = parsed.problems;
		if (parsed.groups !== undefined) {
			onapply(parsed.groups);
		}
	}

	async function copy() {
		await navigator.clipboard.writeText(text);
		ctx.toasts.push('Copied to the clipboard', 'success');
	}

	function download() {
		const link = document.createElement('a');
		link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
		link.download = 'taxonomy.json';
		link.click();
		URL.revokeObjectURL(link.href);
	}

	async function upload(event: Event & { currentTarget: HTMLInputElement }) {
		const file = event.currentTarget.files?.[0];
		if (file === undefined) return;
		text = await file.text();
		event.currentTarget.value = '';
		apply();
	}
</script>

<div class="flex flex-col gap-3">
	{#if problems.length}
		<div class="alert alert-error flex-col items-start">
			{#each problems as problem (problem)}<span>{problem}</span>{/each}
		</div>
	{/if}
	<textarea class="input h-[28rem] resize-y py-2 font-mono text-xs" spellcheck="false" bind:value={text}></textarea>
	<div class="flex items-center gap-2">
		<button type="button" class="btn btn-primary btn-sm" onclick={apply}>Apply to editor</button>
		<button type="button" class="btn btn-outline btn-sm" onclick={copy}><CopyIcon size={13} /> Copy</button>
		<button type="button" class="btn btn-outline btn-sm" onclick={download}><DownloadSimpleIcon size={13} /> Export file</button>
		<label class="btn btn-outline btn-sm cursor-pointer">
			<UploadSimpleIcon size={13} /> Import file
			<input type="file" accept="application/json,.json" class="hidden" onchange={upload} />
		</label>
	</div>
</div>
