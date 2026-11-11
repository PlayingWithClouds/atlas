<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { kernelContext } from '../../kernel/context';
	import EmptyState from '../../lib/components/EmptyState.svelte';
	import CheatSheet from './CheatSheet.svelte';
	import GroupsPanel from './GroupsPanel.svelte';
	import ItemHeader from './ItemHeader.svelte';
	import KeyLegend from './KeyLegend.svelte';
	import { LabelingSession } from './labelingSession.svelte';
	import MetaDetails from './MetaDetails.svelte';
	import { effectiveSpan } from './ranges';
	import Timeline from './Timeline.svelte';
	import { formatClock, formatSpan } from '../shared/time';

	let { params }: { params: Record<string, string> } = $props();

	const ctx = kernelContext();
	// svelte-ignore state_referenced_locally
	const session = new LabelingSession(ctx, () => params.project);

	let cheatSheetOpen = $state(false);
	/** Asset seconds hovered on the timeline; the player area shows that frame meanwhile. */
	let previewSeconds = $state<number | undefined>(undefined);
	/** The last previewed time; the preview stays mounted (hidden) so it never restarts from black. */
	let lastPreviewSeconds = $state<number | undefined>(undefined);

	function setPreview(seconds: number | undefined): void {
		previewSeconds = seconds;
		if (seconds !== undefined) {
			lastPreviewSeconds = seconds;
		}
	}

	const detail = $derived(session.detail);
	const media = $derived.by(() => {
		if (detail === undefined) {
			return undefined;
		}
		return ctx.mediaPlayers.list().find((candidate) => candidate.kind === detail.asset.kind);
	});
	const pending = $derived.by(() => {
		const summary = ctx.projects.find(params.project);
		if (summary === undefined) {
			return 0;
		}
		return summary.items - summary.labeled - summary.skipped;
	});
	const itemSpan = $derived.by(() => {
		if (detail === undefined) {
			return undefined;
		}
		return effectiveSpan(detail.item.span, undefined, detail.asset.duration);
	});
	const showTimeline = $derived(detail !== undefined && detail.asset.kind === 'video' && itemSpan !== undefined);
	const problemLines = $derived([...session.problems, ...session.serverProblems]);

	function isTypingTarget(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) {
			return false;
		}
		return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
	}

	function onKeydown(event: KeyboardEvent) {
		if (cheatSheetOpen || isTypingTarget(event.target)) {
			return;
		}
		const action = session.handleKey(event);
		if (action === undefined) {
			return;
		}
		event.preventDefault();
		if (action.kind === 'cheatSheet') {
			cheatSheetOpen = true;
		}
	}

	$effect(() => {
		const itemId = params.item;
		void params.project;
		untrack(() => void session.open(itemId));
	});

	onMount(() => {
		const unsubscribe = ctx.live.subscribe((signal) => {
			if (signal.type === 'connected') {
				void session.refreshDetail();
				return;
			}
			if (signal.type === 'projects' || signal.projectId !== params.project) return;
			if (signal.type === 'taxonomy') {
				session.onTaxonomyChanged(signal.taxonomy);
				return;
			}
			if ((signal.type === 'suggestions' || signal.type === 'items') && session.item !== undefined && signal.ids.includes(session.item.id)) {
				void session.refreshDetail();
			}
		});
		return () => {
			unsubscribe();
			session.dispose();
		};
	});
</script>

<svelte:window onkeydown={onKeydown} />

{#if session.loadError}
	<div class="p-6">
		<EmptyState title="Could not open this item" hint={session.loadError}>
			<button type="button" class="btn btn-sm btn-primary" onclick={() => session.leave()}>Back to the queue</button>
		</EmptyState>
	</div>
{:else if detail === undefined}
	<div class="text-dim flex justify-center py-16"><span class="loading"></span></div>
{:else}
	<div class="flex h-full min-h-0 flex-col">
		<ItemHeader {detail} {pending} dirty={session.dirty} onleave={() => session.leave()} onneighbour={(offset) => session.openNeighbour(offset)} />

		<div class="flex min-h-0 flex-1 {session.loading ? 'opacity-60' : ''}">
			<div class="flex min-w-0 flex-1 flex-col gap-3 pb-1">
				<div class="relative min-h-0 flex-1 overflow-hidden bg-black">
					{#if media}
						<media.player asset={detail.asset} span={session.playSpan} poster={detail.item.poster} onready={(handle) => session.setHandle(handle)} ontime={(seconds) => (session.playhead = seconds)} />
						{#if media.frame && lastPreviewSeconds !== undefined}
							<div class="pointer-events-none absolute inset-0 z-10 bg-black {previewSeconds === undefined ? 'invisible' : ''}">
								<media.frame asset={detail.asset} seconds={lastPreviewSeconds} />
								<span class="absolute top-3 left-1/2 -translate-x-1/2 rounded-md bg-black/70 px-2.5 py-1 font-mono text-sm text-white tabular-nums">{formatClock(lastPreviewSeconds, 2)}</span>
							</div>
						{/if}
					{:else}
						<EmptyState title={`No player for ${detail.asset.kind}`} hint="Enable a media plugin that registers a player for this kind." />
					{/if}
				</div>

				{#if showTimeline && itemSpan}
					<div class="flex flex-col gap-2 px-4">
						<Timeline
							asset={detail.asset}
							{media}
							{itemSpan}
							trimmed={session.draft.span}
							playhead={session.playhead}
							frameRate={session.frameRate()}
							tracks={session.tracks}
							pending={session.pendingRange}
							itemStart={session.itemStart}
							length={session.length}
							selected={session.selectedRange}
							looped={session.loopedRange}
							onseek={(seconds) => session.seekTo(seconds)}
							onselect={(range) => session.selectRange(range)}
							onloop={(range) => session.toggleLoop(range)}
							oncreate={(target, first, second) => session.createRange(target, first, second)}
							onchange={(previous, next) => session.replaceRange(previous, next)}
							onaccept={(ghost) => session.acceptSuggestedRange(ghost)}
							onarm={(target) => session.armLabel(target)}
							selectedRefinements={session.selectedRefinements}
							onrefine={(target) => session.refineSelected(target)}
							onhover={setPreview}
							onscrub={() => session.pause()}
							ondelete={(range) => session.deleteRange(range)}
						/>
						{#if session.loopedRange}
							<div class="text-amber flex items-center gap-2 text-xs">
								Looping {session.loopedRange.group}.{session.loopedRange.label} only
								<button type="button" tabindex="-1" class="btn btn-ghost btn-xs" onclick={() => session.cancelRange()}>Back to the whole item <kbd class="ml-1 font-mono text-[10px] opacity-60">Esc</kbd></button>
							</div>
						{/if}
						{#if session.draft.span}
							<div class="text-amber flex items-center gap-2 text-xs">
								Trimmed to {formatSpan(session.draft.span)} (recorded with the label; the item itself is unchanged)
								<button type="button" tabindex="-1" class="btn btn-ghost btn-xs" onclick={() => session.resetTrim()}>Reset</button>
							</div>
						{/if}
					</div>
				{/if}
				<div class="px-4"><MetaDetails {detail} /></div>
				<KeyLegend />
			</div>

			<aside class="border-line bg-canvas flex w-[26rem] shrink-0 flex-col border-l">
				<div class="min-h-0 flex-1 overflow-y-auto">
					<GroupsPanel {session} />
				</div>

				<div class="border-line flex flex-col gap-2 border-t p-3">
					{#if problemLines.length}
						<div class="alert alert-error flex-col items-start gap-0.5 text-xs">
							{#each problemLines as problem (problem)}<span>{problem}</span>{/each}
						</div>
					{/if}
					{#if session.notice}
						<div class="text-amber px-1 text-xs">{session.notice}</div>
					{/if}

					<div class="flex gap-2">
						<button type="button" tabindex="-1" class="btn flex-1" disabled={session.saving} onmousedown={(event) => event.preventDefault()} onclick={() => void session.save('skipped')}>
							Skip <kbd class="ml-1 font-mono text-[10px] opacity-60">S</kbd>
						</button>
						<button type="button" tabindex="-1" class="btn btn-primary flex-[2]" disabled={session.saving || session.problems.length > 0} onmousedown={(event) => event.preventDefault()} onclick={() => void session.save('labeled')}>
							Save and next <kbd class="ml-1 font-mono text-[10px] opacity-60">Enter</kbd>
						</button>
					</div>
				</div>
			</aside>
		</div>
	</div>
{/if}

<CheatSheet open={cheatSheetOpen} onclose={() => (cheatSheetOpen = false)} />
