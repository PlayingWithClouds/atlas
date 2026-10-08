<script lang="ts">
	// Media tool for span items: drag handles (or keys) adjust a draft range, saved explicitly.
	import type { Item, Project, Session } from '@atlas/contracts';
	import { Key } from '@atlas/web/components';
	import { kernelContext } from '@atlas/web/kernel';
	import { untrack } from 'svelte';
	import TrimBar from './TrimBar.svelte';
	import { MIN_SPAN_SECONDS, formatRange } from './playback';

	let { item, session }: { item: Item; session: Session; project: Project } = $props();

	const ctx = kernelContext();
	const NUDGE_SECONDS = 0.25;

	// Seeded once per item: the labeler remounts this tool when the item changes.
	const initialSpan = untrack(() => {
		if (item.span) return item.span;
		return { start: 0, end: 0 };
	});
	let storedStart = $state(initialSpan.start);
	let storedEnd = $state(initialSpan.end);
	let draftStart = $state(initialSpan.start);
	let draftEnd = $state(initialSpan.end);
	let saving = $state(false);

	const duration = $derived(typeof session.meta.duration === 'number' ? session.meta.duration : 0);
	const dirty = $derived(
		Math.abs(draftStart - storedStart) > 0.001 || Math.abs(draftEnd - storedEnd) > 0.001
	);

	function setDraft(start: number, end: number) {
		draftStart = Math.max(0, start);
		draftEnd = Math.max(draftStart + MIN_SPAN_SECONDS, end);
		if (duration > 0 && draftEnd > duration) {
			draftEnd = duration;
			draftStart = Math.min(draftStart, draftEnd - MIN_SPAN_SECONDS);
		}
	}

	function reset() {
		draftStart = storedStart;
		draftEnd = storedEnd;
	}

	async function save() {
		if (!dirty || saving) return;
		saving = true;
		try {
			const saved = await ctx.api.patch<Item>(`/items/${item.id}/span`, { start: draftStart, end: draftEnd });
			if (saved.span) {
				storedStart = saved.span.start;
				storedEnd = saved.span.end;
				reset();
			}
			ctx.toasts.push('Range saved', 'success');
		} catch (failure) {
			ctx.toasts.push(failure instanceof Error ? failure.message : String(failure), 'error');
		} finally {
			saving = false;
		}
	}

	function trimActionForKey(event: KeyboardEvent): (() => void) | undefined {
		if (event.key === '[') return () => setDraft(draftStart - NUDGE_SECONDS, draftEnd);
		if (event.key === ']') return () => setDraft(draftStart + NUDGE_SECONDS, draftEnd);
		if (event.key === '{') return () => setDraft(draftStart, draftEnd - NUDGE_SECONDS);
		if (event.key === '}') return () => setDraft(draftStart, draftEnd + NUDGE_SECONDS);
		if (event.key === '0') return reset;
		if (event.key === 'R' && event.shiftKey) return () => void save();
		return undefined;
	}

	function onWindowKeydown(event: KeyboardEvent) {
		if (!item.span) return;
		if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
		const action = trimActionForKey(event);
		if (!action) return;
		event.preventDefault();
		action();
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if item.span}
	<div class="flex flex-col gap-2">
		<TrimBar
			start={draftStart}
			end={draftEnd}
			{storedStart}
			{storedEnd}
			{duration}
			onChange={setDraft}
		/>
		<div class="flex items-center gap-2 text-xs">
			<span class="text-dim font-mono">{formatRange(draftStart, draftEnd)}</span>
			{#if dirty}
				<span class="text-amber">unsaved trim</span>
				<button type="button" class="btn btn-xs btn-ghost" onclick={reset}>Reset <Key label="0" /></button>
				<button type="button" class="btn btn-xs btn-primary ml-auto" onclick={save} disabled={saving}>
					Save range <Key label="⇧R" />
				</button>
			{:else}
				<span class="text-faint ml-auto">[ ] start · {'{'} {'}'} end</span>
			{/if}
		</div>
	</div>
{/if}
