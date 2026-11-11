<script lang="ts">
	// Per-browser settings: every labeling key (recorded by pressing it), the leader and command
	// menu keys, and the numbers behind seeking, frame steps and zoom.
	import ArrowCounterClockwiseIcon from 'phosphor-svelte/lib/ArrowCounterClockwise';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import XIcon from 'phosphor-svelte/lib/X';
	import PageHeader from '../shared/PageHeader.svelte';
	import { COMMANDS, LEADER_PREFIX, chordToRecord, conflictsOf, displayChord, isModifierKey, normalizeChord } from '../labeling/keyboardMap';
	import type { Settings } from './settings.svelte';
	import { DEFAULT_SETTINGS, settings } from './settings.svelte';

	// Routes pass the project; settings are the same for every project.
	let { params: _params }: { params: Record<string, string> } = $props();

	/** What the next key press goes to: a command's extra chord, the leader, or the command menu. */
	type RecordTarget = { kind: 'command'; id: string } | { kind: 'leader' } | { kind: 'commandMenu' };

	let recording = $state<RecordTarget | undefined>(undefined);
	/** The leader was pressed while recording: the next key completes "<leader> x". */
	let afterLeader = $state(false);

	const conflicts = $derived(conflictsOf(settings.value.bindings));

	function chordsOf(commandId: string): string[] {
		const chords = settings.keymap.chordsOf.get(commandId);
		if (chords === undefined) {
			return [];
		}
		return chords;
	}

	function isOverridden(commandId: string): boolean {
		return settings.value.bindings[commandId] !== undefined;
	}

	function isConflicting(chord: string): boolean {
		return conflicts.has(normalizeChord(chord));
	}

	function removeChord(commandId: string, chord: string) {
		settings.bind(
			commandId,
			chordsOf(commandId).filter((candidate) => candidate !== chord)
		);
	}

	function startRecording(target: RecordTarget) {
		recording = target;
		afterLeader = false;
	}

	function stopRecording() {
		recording = undefined;
		afterLeader = false;
	}

	function isRecording(target: RecordTarget): boolean {
		if (recording === undefined || recording.kind !== target.kind) {
			return false;
		}
		return target.kind !== 'command' || (recording.kind === 'command' && recording.id === target.id);
	}

	/** Captures the press before anything else on the page (labeling keys, command menu) sees it. */
	function onKeydownCapture(event: KeyboardEvent) {
		const target = recording;
		if (target === undefined) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		if (event.key === 'Escape' && !afterLeader) {
			stopRecording();
			return;
		}
		if (isModifierKey(event.key)) return;
		if (target.kind === 'leader') {
			settings.update({ leader: event.key });
			stopRecording();
			return;
		}
		if (target.kind === 'commandMenu') {
			saveCommandMenu(event);
			return;
		}
		recordCommandChord(target.id, event);
	}

	function saveCommandMenu(event: KeyboardEvent) {
		const chord = chordToRecord(event);
		if (chord !== undefined) {
			settings.update({ commandMenu: chord });
		}
		stopRecording();
	}

	function recordCommandChord(commandId: string, event: KeyboardEvent) {
		const isLeaderKey = event.key === settings.value.leader && !event.ctrlKey && !event.altKey && !event.metaKey;
		if (!afterLeader && isLeaderKey) {
			afterLeader = true;
			return;
		}
		const chord = chordToRecord(event);
		if (chord === undefined) return;
		let full = chord;
		if (afterLeader) {
			full = LEADER_PREFIX + chord;
		}
		const existing = chordsOf(commandId);
		if (!existing.some((candidate) => normalizeChord(candidate) === normalizeChord(full))) {
			settings.bind(commandId, [...existing, full]);
		}
		stopRecording();
	}

	function setNumber(field: keyof Settings, raw: string, minimum: number) {
		const value = Number(raw);
		if (!Number.isFinite(value) || value < minimum) return;
		settings.update({ [field]: value });
	}

	function leaderName(): string {
		if (settings.value.leader === ' ') {
			return 'Space';
		}
		return settings.value.leader;
	}

	function syncText(): string {
		const texts = {
			synced: 'Shared by every browser on this workspace (atlas.json)',
			saving: 'Saving…',
			offline: 'Server unreachable: kept in this browser, shared once it is back'
		};
		return texts[settings.sync];
	}

		function resetAll() {
		if (confirm('Reset every key and setting to its default?')) {
			settings.resetAll();
		}
	}
</script>

<svelte:window onkeydowncapture={onKeydownCapture} />

<div class="mx-auto max-w-4xl p-6">
	<PageHeader title="Settings" subtitle={syncText()}>
		{#snippet actions()}
			<button type="button" class="btn btn-outline" onclick={resetAll}><ArrowCounterClockwiseIcon size={14} /> Reset all</button>
		{/snippet}
	</PageHeader>

	{#snippet recordButton(target: RecordTarget, label: string)}
		<button type="button" class="btn btn-sm {isRecording(target) ? 'btn-primary' : 'btn-ghost border-line'}" onclick={() => startRecording(target)}>
			{#if isRecording(target)}
				{#if afterLeader}{leaderName()} … next key{:else}Press a key… <span class="opacity-60">(Esc cancels)</span>{/if}
			{:else}
				{label}
			{/if}
		</button>
	{/snippet}

	<section class="border-line mb-6 rounded-lg border">
		<h2 class="border-line text-default border-b px-4 py-3 text-base font-semibold">Keys</h2>
		<div class="border-line grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-3 border-b px-4 py-3 text-[15px]">
			<div>
				<div class="text-default">Leader key</div>
				<div class="text-dim text-sm">Starts sequences like leader then F. Space stops working as play / pause if you pick it.</div>
			</div>
			<div class="flex items-center gap-2">
				<kbd class="kbd-chip">{leaderName()}</kbd>
				{@render recordButton({ kind: 'leader' }, 'Change')}
			</div>
			<div>
				<div class="text-default">Command menu</div>
				<div class="text-dim text-sm">Anywhere in the app; F1 always works too.</div>
			</div>
			<div class="flex items-center gap-2">
				<kbd class="kbd-chip">{settings.value.commandMenu}</kbd>
				{@render recordButton({ kind: 'commandMenu' }, 'Change')}
			</div>
		</div>

		<table class="w-full text-[15px]">
			<tbody>
				{#each COMMANDS as command (command.id)}
					<tr class="border-line-faint border-b last:border-b-0">
						<td class="text-default py-2 pr-3 pl-4">{command.title}</td>
						<td class="py-2 pr-2">
							<div class="flex flex-wrap items-center justify-end gap-1.5">
								{#each chordsOf(command.id) as chord (chord)}
									<span class="kbd-chip flex items-center gap-1" class:kbd-conflict={isConflicting(chord)} title={isConflicting(chord) ? `Also bound to: ${conflicts.get(normalizeChord(chord))?.join(', ')}` : ''}>
										{displayChord(chord, settings.keymap)}
										<button type="button" class="opacity-50 hover:opacity-100" onclick={() => removeChord(command.id, chord)} aria-label="Remove {chord}"><XIcon size={11} /></button>
									</span>
								{/each}
								{#if chordsOf(command.id).length === 0}<span class="text-faint text-sm">no key</span>{/if}
							</div>
						</td>
						<td class="w-0 py-2 pr-4 whitespace-nowrap">
							<div class="flex items-center gap-1">
								{#if isRecording({ kind: 'command', id: command.id })}
									{@render recordButton({ kind: 'command', id: command.id }, '')}
								{:else}
									<button type="button" class="btn btn-ghost btn-sm btn-square" onclick={() => startRecording({ kind: 'command', id: command.id })} title="Add a key"><PlusIcon size={14} /></button>
								{/if}
								<button
									type="button"
									class="btn btn-ghost btn-sm btn-square {isOverridden(command.id) ? '' : 'invisible'}"
									onclick={() => settings.resetBinding(command.id)}
									title="Back to {command.defaults.join(', ')}"><ArrowCounterClockwiseIcon size={14} /></button
								>
							</div>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>

	<section class="border-line mb-6 rounded-lg border">
		<h2 class="border-line text-default border-b px-4 py-3 text-base font-semibold">Playback and timeline</h2>
		<div class="grid grid-cols-[1fr_8rem] items-center gap-x-4 gap-y-3 px-4 py-3 text-[15px]">
			<label class="text-default" for="seek-seconds">Seek step <span class="text-dim text-sm">(seconds, ← →)</span></label>
			<input id="seek-seconds" class="input input-sm" type="number" min="0.1" step="0.1" value={settings.value.seekSeconds} onchange={(event) => setNumber('seekSeconds', event.currentTarget.value, 0.1)} />
			<label class="text-default" for="frame-jump">Frame jump <span class="text-dim text-sm">(frames, Shift , .)</span></label>
			<input id="frame-jump" class="input input-sm" type="number" min="2" step="1" value={settings.value.frameJump} onchange={(event) => setNumber('frameJump', event.currentTarget.value, 2)} />
			<label class="text-default" for="zoom-step">Zoom step <span class="text-dim text-sm">(factor per + / -)</span></label>
			<input id="zoom-step" class="input input-sm" type="number" min="1.05" step="0.05" value={settings.value.zoomStep} onchange={(event) => setNumber('zoomStep', event.currentTarget.value, 1.05)} />
			<label class="text-default" for="live-timeout">Live suggestions wait <span class="text-dim text-sm">(ms, then S uses pushed ones)</span></label>
			<input id="live-timeout" class="input input-sm" type="number" min="100" step="100" value={settings.value.liveTimeoutMs} onchange={(event) => setNumber('liveTimeoutMs', event.currentTarget.value, 100)} />
		</div>
	</section>

	<section class="border-line rounded-lg border">
		<h2 class="border-line text-default border-b px-4 py-3 text-base font-semibold">Labeling panel</h2>
		<label class="flex items-center gap-3 px-4 py-3 text-[15px]">
			<input type="checkbox" class="toggle toggle-sm" checked={settings.value.expandMoreGroups} onchange={(event) => settings.update({ expandMoreGroups: event.currentTarget.checked })} />
			<span class="text-default">Open "More groups" on every item</span>
			<span class="text-dim text-sm">Open groups count as reviewed ("none of these") unless marked not reviewed.</span>
		</label>
	</section>

	{#if JSON.stringify(settings.value) === JSON.stringify(DEFAULT_SETTINGS)}
		<p class="text-faint mt-4 text-sm">Everything is at its default.</p>
	{/if}
</div>

<style>
	.kbd-chip {
		border: 1px solid var(--border-strong);
		border-radius: 0.375rem;
		background: var(--surface-raised);
		padding: 0.125rem 0.5rem;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.8125rem;
		color: var(--text);
		white-space: nowrap;
	}

	.kbd-conflict {
		border-color: var(--ctx-amber);
		color: var(--ctx-amber);
	}
</style>
