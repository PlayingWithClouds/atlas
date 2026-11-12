import { isGroupActive, itemLength, validateAnnotation } from '@atlas/contracts';
import type { AnnotationStatus, Group, ItemDetail, ItemView, Project, Range, Suggestion } from '@atlas/contracts';
import type { PlayerHandle } from '@atlas/contracts/web';
import type { Context } from '@neoworks/extension-system';
import { apiItemPath, labelPath, queuePath } from '../queue/itemLink';
import { messageOf, problemsOf } from '../shared/errors';
import {
  buildAnnotationInput,
  activeRefinements,
  clearGroup,
  copyValues,
  draftFromAnnotation,
  emptyDraft,
  fingerprintOf,
  focusableGroups,
  hasLabels,
  layoutGroups,
  offeredLabels,
  setMoreExpanded,
  setNotReviewed,
  toggleLabel,
  valuesOfGroup,
} from './draft';
import type { Draft } from './draft';
import { actionForKey, isRepeatable, pressOf } from './keyboardMap';
import type { KeyPress, LabelAction } from './keyboardMap';
import { MIN_RANGE_SECONDS, addRange, closePending, deleteRange, effectiveSpan, findPending, isSameSpan, itemTimeOf, refineRange, replaceRange, restartPending, togglePending, trimEdge } from './ranges';
import type { PendingRange, RangeTarget } from './ranges';
import { acceptProposals, chooseSuggestion } from './suggestions';
import { confidentAdditions, emptyAutoAdded, personsAnnotation, rangeKey, valueKey } from './liveSuggestions';
import type { AutoAdded, LiveAnnotation } from './liveSuggestions';
import { labelTracks, rangeBetween, rangesFromHere } from './timeline';
import type { SuggestedRange } from './timeline';
import { settings } from '../settings/settings.svelte';

const NOTICE_LIFETIME_MS = 4000;
/** Edits in quick succession ask the live endpoint once. */
const LIVE_DELAY_MS = 300;
/** The first ask for a scene embeds it densely, which can take a while. */
const LIVE_SCENE_TIMEOUT_MS = 120_000;

/** Everything the labeling screen knows and can do for one item at a time. */
/** How long the leader waits for the key that completes its sequence. */
const LEADER_WINDOW_MS = 1500;

function tookMessage(count: number): string {
  if (count === 0) {
    return 'No suggested section at the playhead';
  }
  if (count === 1) {
    return 'Took 1 suggested section from here';
  }
  return `Took ${count} suggested sections from here`;
}

function addedMessage(count: number): string {
  if (count === 1) {
    return 'Added 1 confident label';
  }
  return `Added ${count} confident labels`;
}

export class LabelingSession {
  project = $state.raw<Project | undefined>(undefined);
  detail = $state.raw<ItemDetail | undefined>(undefined);
  draft = $state.raw<Draft>(emptyDraft());
  focusedGroupId = $state<string | undefined>(undefined);
  /** The label search box at the top of the panel (/). */
  searchOpen = $state(false);
  /** S: the model's ranges at one moment, offered to pick from; undefined while closed. */
  suggestionPicker = $state.raw<{ time: number; ranges: SuggestedRange[] } | undefined>(undefined);
  /** Each request bumps `id`; the timeline zooms by `factor` around the playhead. */
  zoomRequest = $state.raw<{ id: number; factor: number } | undefined>(undefined);
  /** The leader key was pressed and waits for the rest of its sequence. */
  leaderPending = $state(false);
  private leaderTimer: ReturnType<typeof setTimeout> | undefined;
  /** Ranges started at the playhead and waiting for ] (or R) to end them; several at once. */
  openRanges = $state.raw<PendingRange[]>([]);
  /** The range clicked on the timeline; [ and ] move its edges, Backspace deletes it. */
  selectedRange = $state.raw<Range | undefined>(undefined);
  /** A range the player loops instead of the item (double-click on it). */
  loopedRange = $state.raw<Range | undefined>(undefined);
  playhead = $state(0);
  loading = $state(true);
  saving = $state(false);
  loadError = $state('');
  serverProblems = $state.raw<string[]>([]);
  notice = $state('');
  handle = $state.raw<PlayerHandle | undefined>(undefined);
  /** The adapter's latest whole-scene answer to the draft (POST to liveSuggestions). */
  liveSuggestion = $state.raw<Suggestion | undefined>(undefined);
  /** A live request is on its way. */
  liveUpdating = $state(false);

  /** Labels atlas added by itself and still in the draft; never sent to the model as the person's. */
  private autoAdded: AutoAdded = emptyAutoAdded();
  /** Everything ever auto-added on this item: what the person removed is not added again. */
  private autoOffered: AutoAdded = emptyAutoAdded();
  private liveCounter = 0;
  private liveTimer: ReturnType<typeof setTimeout> | undefined;
  private liveAbort: AbortController | undefined;
  private lastLiveRequest = '';

  private loadedFingerprint = $state('');
  private lastTouchedLabel = $state.raw<Record<string, string>>({});
  private loadCounter = 0;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  readonly taxonomy = $derived(this.project?.taxonomy);
  readonly item = $derived(this.detail?.item);
  readonly asset = $derived(this.detail?.asset);
  readonly length = $derived.by(() => {
    if (this.item === undefined) {
      return undefined;
    }
    return itemLength(this.item, this.asset?.duration);
  });
  readonly itemStart = $derived.by(() => {
    if (this.item === undefined || this.item.span === undefined) {
      return 0;
    }
    return this.item.span.start;
  });
  readonly playSpan = $derived.by(() => {
    if (this.item === undefined) {
      return undefined;
    }
    const looped = this.loopedRange;
    if (looped !== undefined && this.draft.ranges.includes(looped)) {
      return { start: this.itemStart + looped.start, end: this.itemStart + looped.end };
    }
    return effectiveSpan(this.item.span, this.draft.span, this.asset?.duration);
  });
  readonly layout = $derived.by(() => {
    if (this.taxonomy === undefined) {
      return { primary: [], more: [] };
    }
    return layoutGroups(this.taxonomy, this.draft);
  });
  readonly focusable = $derived.by(() => {
    if (this.taxonomy === undefined) {
      return [];
    }
    return focusableGroups(this.taxonomy, this.draft);
  });
  readonly focusedGroup = $derived.by(() => {
    const focused = this.focusable.find((group) => group.id === this.focusedGroupId);
    if (focused !== undefined) {
      return focused;
    }
    return this.focusable[0];
  });
  readonly suggestion = $derived.by(() => {
    if (this.detail === undefined || this.project === undefined) {
      return undefined;
    }
    if (this.liveSuggestion !== undefined) {
      return this.liveSuggestion;
    }
    return chooseSuggestion(this.detail.suggestions, this.project.prefillSource);
  });
  /** The label R, [ ] and a drag in its track act on: the focused group's last touched label. */
  readonly armed = $derived.by((): RangeTarget | undefined => {
    const group = this.focusedGroup;
    if (group === undefined) {
      return undefined;
    }
    const labelId = this.focusedLabelId(group);
    if (labelId === undefined) {
      return undefined;
    }
    return { group: group.id, label: labelId };
  });
  readonly tracks = $derived.by(() => {
    if (this.taxonomy === undefined) {
      return [];
    }
    let suggested: SuggestedRange[] = [];
    if (this.suggestion !== undefined && this.suggestion.ranges !== undefined) {
      suggested = this.suggestion.ranges;
    }
    return labelTracks({
      groups: this.taxonomy.groups,
      values: this.draft.values,
      ranges: this.draft.ranges,
      suggested,
      armed: this.armed,
      open: this.openRanges,
    });
  });
  /** Refinement groups of the selected range's label, with the labels set for exactly its span. */
  readonly selectedRefinements = $derived.by(() => {
    const selected = this.selectedRange;
    if (this.taxonomy === undefined || selected === undefined || !this.draft.ranges.includes(selected)) {
      return [];
    }
    return activeRefinements(this.taxonomy, this.draft, selected.group)
      .filter((group) => group.when !== undefined && group.when.label === selected.label)
      .map((group) => ({
        group,
        chosen: this.draft.ranges.filter((range) => range.group === group.id && isSameSpan(range, selected)).map((range) => range.label),
        wholeItem: valuesOfGroup(this.draft, group.id),
      }));
  });
  readonly acceptable = $derived.by(() => {
    if (this.taxonomy === undefined) {
      return false;
    }
    const accepted = acceptProposals(this.taxonomy, this.draft, this.suggestion);
    return JSON.stringify(accepted.values) !== JSON.stringify(this.draft.values);
  });
  readonly problems = $derived.by(() => {
    if (this.taxonomy === undefined) {
      return [];
    }
    const input = buildAnnotationInput(this.taxonomy, this.draft, 'labeled');
    return validateAnnotation(this.taxonomy, input, this.length);
  });
  readonly dirty = $derived.by(() => {
    if (this.taxonomy === undefined) {
      return false;
    }
    return fingerprintOf(this.taxonomy, this.draft) !== this.loadedFingerprint;
  });

  constructor(
    private readonly ctx: Context,
    private readonly projectId: () => string,
  ) {}

  // --- loading -------------------------------------------------------------------------

  async open(itemId: string): Promise<void> {
    this.loadCounter += 1;
    const thisLoad = this.loadCounter;
    this.loading = true;
    this.loadError = '';
    try {
      const project = await this.fetchProject();
      const detail = await this.ctx.api.get<ItemDetail>(apiItemPath(this.projectId(), itemId));
      if (thisLoad !== this.loadCounter) {
        return;
      }
      this.adopt(project, detail);
    } catch (failure) {
      if (thisLoad === this.loadCounter) {
        this.loadError = messageOf(failure);
      }
    }
    if (thisLoad === this.loadCounter) {
      this.loading = false;
    }
  }

  private async fetchProject(): Promise<Project> {
    const known = this.project;
    if (known !== undefined && known.id === this.projectId()) {
      return known;
    }
    return this.ctx.api.get<Project>(`/projects/${encodeURIComponent(this.projectId())}`);
  }

  private adopt(project: Project, detail: ItemDetail): void {
    const sameAsset = this.asset !== undefined && this.asset.id === detail.asset.id;
    this.project = project;
    this.detail = detail;
    this.draft = draftFromAnnotation(project.taxonomy, detail.annotation);
    this.loadedFingerprint = fingerprintOf(project.taxonomy, this.draft);
    // Opened after the fingerprint: expanding alone is no edit worth an "unsaved" badge.
    if (settings.value.expandMoreGroups && !this.draft.moreExpanded) {
      this.draft = setMoreExpanded(this.draft, true);
      this.loadedFingerprint = fingerprintOf(project.taxonomy, this.draft);
    }
    this.openRanges = [];
    this.selectedRange = undefined;
    this.loopedRange = undefined;
    this.serverProblems = [];
    this.lastTouchedLabel = {};
    this.focusedGroupId = this.focusable[0]?.id;
    this.restartPlayback(sameAsset);
    this.resetLive();
    this.scheduleLive();
  }

  /** A new video loads itself paused at its span start; the same video just jumps to the new scene, paused. */
  private restartPlayback(sameAsset: boolean): void {
    // The timeline shows the scene start at once, not 0 until the player reports in.
    if (this.playSpan !== undefined) {
      this.playhead = this.playSpan.start;
    }
    if (!sameAsset || this.handle === undefined || this.playSpan === undefined) {
      return;
    }
    this.handle.pause();
    this.handle.seek(this.playSpan.start);
  }

  pause(): void {
    this.handle?.pause();
  }

  /** Re-reads the item (new suggestions, neighbours) without touching what the person has typed. */
  async refreshDetail(): Promise<void> {
    if (this.item === undefined) {
      return;
    }
    try {
      this.detail = await this.ctx.api.get<ItemDetail>(apiItemPath(this.projectId(), this.item.id));
    } catch (failure) {
      this.say(messageOf(failure));
    }
  }

  onTaxonomyChanged(taxonomy: Project['taxonomy']): void {
    if (this.project !== undefined) {
      this.project = { ...this.project, taxonomy };
    }
  }

  // --- player --------------------------------------------------------------------------

  setHandle(handle: PlayerHandle): void {
    this.handle = handle;
  }

  private currentTime(): number {
    if (this.handle === undefined) {
      return 0;
    }
    return this.handle.currentTime;
  }

  togglePlay(): void {
    if (this.handle === undefined) {
      return;
    }
    if (this.handle.paused) {
      this.handle.play();
      return;
    }
    this.handle.pause();
  }

  seekBy(seconds: number): void {
    this.handle?.seek(this.currentTime() + seconds);
  }

  seekTo(seconds: number): void {
    this.handle?.seek(seconds);
  }

  stepFrames(count: number): void {
    this.handle?.stepFrames(count);
  }

  /** 0 / $: the playhead to the first or last frame of the scene (or its trim). */
  seekToSceneEdge(edge: 'start' | 'end'): void {
    const span = this.playSpan;
    if (span === undefined) {
      return;
    }
    if (edge === 'start') {
      this.seekTo(span.start);
      return;
    }
    this.seekTo(Math.max(span.start, span.end - 1 / this.frameRate()));
  }

  zoomTimeline(direction: 1 | -1): void {
    let factor = settings.value.zoomStep;
    if (direction === 1) {
      factor = 1 / factor;
    }
    let id = 1;
    if (this.zoomRequest !== undefined) {
      id = this.zoomRequest.id + 1;
    }
    this.zoomRequest = { id, factor };
  }

  frameRate(): number {
    if (this.handle === undefined) {
      return 30;
    }
    return this.handle.frameRate;
  }

  toggleMuted(): void {
    this.handle?.setMuted(!this.handle.muted);
  }

  // --- draft edits ---------------------------------------------------------------------

  private edit(change: (taxonomy: NonNullable<LabelingSession['taxonomy']>, draft: Draft) => Draft): void {
    if (this.taxonomy === undefined || this.loading) {
      return;
    }
    this.draft = change(this.taxonomy, this.draft);
    this.serverProblems = [];
    this.scheduleLive();
  }

  focusGroup(groupId: string): void {
    this.focusedGroupId = groupId;
  }

  moveFocus(offset: number): void {
    const groups = this.focusable;
    if (groups.length === 0) {
      return;
    }
    const current = groups.findIndex((group) => group.id === this.focusedGroup?.id);
    const next = (current + offset + groups.length) % groups.length;
    this.focusedGroupId = groups[next].id;
  }

  toggle(group: Group, labelId: string): void {
    this.focusedGroupId = group.id;
    this.lastTouchedLabel = { ...this.lastTouchedLabel, [group.id]: labelId };
    const wasPicked = valuesOfGroup(this.draft, group.id).includes(labelId);
    this.edit((taxonomy, draft) => toggleLabel(taxonomy, draft, group, labelId));
    const isPicked = valuesOfGroup(this.draft, group.id).includes(labelId);
    if (group.kind === 'single' && !wasPicked && isPicked) {
      this.focusAfter(group.id);
    }
  }

  /** A single choice is answered once picked: move on, to a refinement it just opened first. */
  private focusAfter(groupId: string): void {
    const groups = this.focusable;
    const index = groups.findIndex((group) => group.id === groupId);
    if (index < 0 || index + 1 >= groups.length) {
      return;
    }
    this.focusedGroupId = groups[index + 1].id;
  }

  /** A label picked from search; a group behind "More groups" opens them first so it stays visible. */
  pickSearched(group: Group, labelId: string): void {
    const behindMore = this.layout.more.some((candidate) => candidate.id === group.id || candidate.id === group.when?.group);
    if (behindMore && !this.draft.moreExpanded) {
      this.toggleMore();
    }
    if (this.asset !== undefined && this.asset.kind === 'video') {
      this.toggleOpenRange(group, labelId);
    } else {
      this.toggle(group, labelId);
    }
    this.searchOpen = false;
  }

  toggleFocusedLabel(labelId: string): void {
    if (this.focusedGroup !== undefined) {
      this.toggle(this.focusedGroup, labelId);
    }
  }

  clearFocusedGroup(): void {
    const group = this.focusedGroup;
    if (group !== undefined) {
      this.edit((taxonomy, draft) => clearGroup(taxonomy, draft, group.id));
    }
  }

  setReviewed(groupId: string, reviewed: boolean): void {
    this.edit((_taxonomy, draft) => setNotReviewed(draft, groupId, !reviewed));
  }

  toggleFocusedReviewed(): void {
    const group = this.focusedGroup;
    if (group === undefined || hasLabels(this.draft, group.id)) {
      return;
    }
    this.setReviewed(group.id, this.draft.notReviewed.includes(group.id));
  }

  toggleMore(): void {
    this.edit((_taxonomy, draft) => setMoreExpanded(draft, !draft.moreExpanded));
  }

  acceptSuggestions(): void {
    const suggestion = this.suggestion;
    this.edit((taxonomy, draft) => acceptProposals(taxonomy, draft, suggestion));
  }

  copyPrevious(): void {
    const annotation = this.detail?.previous?.annotation;
    if (annotation === undefined || annotation.status === 'skipped' || Object.keys(annotation.values).length === 0) {
      this.say('The previous scene of this video has no labels to copy');
      return;
    }
    this.edit((taxonomy, draft) => copyValues(taxonomy, draft, annotation.values));
  }

  // --- trim and ranges -----------------------------------------------------------------

  /** [ and ]: open ranges start over / close; else the selected range's edge; else the item's trim. */
  setEdge(edge: 'start' | 'end'): void {
    if (this.openRanges.length > 0 && edge === 'end') {
      this.closeOpenRanges();
      return;
    }
    if (this.openRanges.length > 0) {
      this.openRanges = restartPending(this.openRanges, itemTimeOf(this.currentTime(), this.itemStart, this.length));
      return;
    }
    const selected = this.selectedRange;
    if (selected !== undefined && this.draft.ranges.includes(selected)) {
      this.moveRangeEdge(selected, edge);
      return;
    }
    this.trim(edge);
  }

  private moveRangeEdge(range: Range, edge: 'start' | 'end'): void {
    const time = itemTimeOf(this.currentTime(), this.itemStart, this.length);
    const next = { ...range, [edge]: time };
    if (next.end - next.start < MIN_RANGE_SECONDS) {
      this.say('A range must start before it ends: move the playhead first');
      return;
    }
    this.replaceRange(range, next);
  }

  trim(edge: 'start' | 'end'): void {
    if (this.item === undefined || this.asset === undefined || this.asset.kind !== 'video') {
      this.say('Trimming needs a video');
      return;
    }
    const step = trimEdge(edge, this.currentTime(), this.item.span, this.draft.span, this.asset.duration);
    if (step.problem !== undefined) {
      this.say(step.problem);
      return;
    }
    this.edit((_taxonomy, draft) => ({ ...draft, span: step.span }));
  }

  resetTrim(): void {
    this.edit((_taxonomy, draft) => ({ ...draft, span: undefined }));
  }

  focusedLabelId(group: Group): string | undefined {
    const touched = this.lastTouchedLabel[group.id];
    const offered = offeredLabels(group, this.draft);
    if (touched !== undefined && offered.some((label) => label.id === touched)) {
      return touched;
    }
    return valuesOfGroup(this.draft, group.id)[0];
  }

  /** Starts a range for the label at the playhead, or drops it when it is already open. */
  toggleOpenRange(group: Group, labelId: string): void {
    const target = { group: group.id, label: labelId };
    const time = itemTimeOf(this.currentTime(), this.itemStart, this.length);
    this.openRanges = togglePending(this.openRanges, target, time);
    this.lastTouchedLabel = { ...this.lastTouchedLabel, [group.id]: labelId };
    this.focusedGroupId = group.id;
  }

  isOpenRange(groupId: string, labelId: string): boolean {
    return findPending(this.openRanges, { group: groupId, label: labelId }) !== undefined;
  }

  /** ]: ends every open range at the playhead. */
  private closeOpenRanges(): void {
    const time = itemTimeOf(this.currentTime(), this.itemStart, this.length);
    const closed = closePending(this.openRanges, time);
    if (closed.problem !== undefined) {
      this.say(closed.problem);
    }
    this.openRanges = closed.open;
    for (const range of closed.ranges) {
      this.edit((taxonomy, draft) => addRange(taxonomy, draft, range));
    }
    const last = closed.ranges[closed.ranges.length - 1];
    if (last !== undefined) {
      this.selectedRange = this.draft.ranges.find((candidate) => candidate === last);
    }
  }

  /**
   * S: the labels on at the playhead become ranges from here to where they end. The project's
   * live endpoint is asked for this exact moment; without one (or when it does not answer) the
   * pushed suggestions' ranges are used.
   */
  async acceptSuggestionsHere(): Promise<void> {
    const time = itemTimeOf(this.currentTime(), this.itemStart, this.length);
    let suggested = await this.liveRangesAt(time);
    if (suggested === undefined) {
      suggested = this.storedSuggestedRanges();
    }
    const offered = rangesFromHere(suggested, this.draft.ranges, time, MIN_RANGE_SECONDS).filter((range) => this.isOffered(range));
    if (offered.length === 0) {
      this.say('No suggested section at the playhead');
      return;
    }
    const scores = new Map(suggested.map((ghost) => [`${ghost.group}.${ghost.label}`, ghost.score]));
    this.suggestionPicker = {
      time,
      ranges: offered.map((range) => ({ ...range, score: scores.get(`${range.group}.${range.label}`) || 0 })),
    };
  }

  /** Labels drawn on the timeline: a refinement only once its parent is on. */
  private isOffered(range: Range): boolean {
    const group = this.taxonomy?.groups.find((candidate) => candidate.id === range.group);
    return group !== undefined && isGroupActive(group, this.draft.values, this.draft.ranges);
  }

  /** The picked suggestions become ranges; refinements whose parent is not on are left out. */
  takeSuggestions(picked: SuggestedRange[]): void {
    let added = 0;
    for (const suggestion of picked) {
      const range = { group: suggestion.group, label: suggestion.label, start: suggestion.start, end: suggestion.end };
      if (!this.isOffered(range)) {
        continue;
      }
      this.edit((taxonomy, draft) => addRange(taxonomy, draft, range));
      added += 1;
    }
    this.suggestionPicker = undefined;
    this.say(tookMessage(added));
  }

  closeSuggestionPicker(): void {
    this.suggestionPicker = undefined;
  }

  private storedSuggestedRanges(): SuggestedRange[] {
    if (this.suggestion === undefined || this.suggestion.ranges === undefined) {
      return [];
    }
    return this.suggestion.ranges;
  }

  /** Ranges the adapter predicts from `time` on, or undefined when there is no live endpoint or it fails. */
  private async liveRangesAt(time: number): Promise<SuggestedRange[] | undefined> {
    const url = this.project?.liveSuggestions;
    if (url === undefined || this.item === undefined) {
      return undefined;
    }
    const query = new URLSearchParams({ item: this.item.id, at: time.toFixed(3) });
    try {
      const response = await fetch(`${url}?${query}`, { signal: AbortSignal.timeout(settings.value.liveTimeoutMs) });
      if (!response.ok) {
        return undefined;
      }
      const body = (await response.json()) as { ranges?: SuggestedRange[] };
      if (!Array.isArray(body.ranges)) {
        return undefined;
      }
      // `at` went out rounded; ranges that start there must still count as under the playhead.
      return body.ranges.map((range) => ({ ...range, start: Math.min(range.start, time) }));
    } catch {
      return undefined;
    }
  }

  /** Leader then F: the open labels hold for the whole item instead of a range. */
  wholeItem(): void {
    if (this.openRanges.length === 0) {
      this.say('Start a label with / first, then leader F makes it hold for the whole scene');
      return;
    }
    const taxonomy = this.taxonomy;
    if (taxonomy === undefined) {
      return;
    }
    for (const pending of this.openRanges) {
      const group = taxonomy.groups.find((candidate) => candidate.id === pending.group);
      if (group === undefined || valuesOfGroup(this.draft, group.id).includes(pending.label)) {
        continue;
      }
      this.edit((current, draft) => toggleLabel(current, draft, group, pending.label));
    }
    this.openRanges = [];
  }

  deleteRange(range: Range): void {
    this.edit((taxonomy, draft) => deleteRange(taxonomy, draft, range));
    if (this.selectedRange === range) {
      this.selectedRange = undefined;
    }
    if (this.loopedRange === range) {
      this.loopedRange = undefined;
    }
  }

  /** Adds a range between two asset times (a drag in a track) and selects it. */
  createRange(target: RangeTarget, firstSeconds: number, secondSeconds: number): void {
    const first = itemTimeOf(firstSeconds, this.itemStart, this.length);
    const second = itemTimeOf(secondSeconds, this.itemStart, this.length);
    const range = rangeBetween(target, first, second, this.length);
    if (range === undefined) {
      return;
    }
    this.armLabel(target);
    this.edit((taxonomy, draft) => addRange(taxonomy, draft, range));
    this.selectedRange = range;
  }

  /** Swaps a range for its edited copy; the selection and loop follow it. */
  replaceRange(previous: Range, next: Range): void {
    this.edit((taxonomy, draft) => replaceRange(taxonomy, draft, previous, next));
    if (this.selectedRange === previous) {
      this.selectedRange = next;
    }
    if (this.loopedRange === previous) {
      this.loopedRange = next;
    }
  }

  acceptSuggestedRange(suggested: SuggestedRange): void {
    const range = { group: suggested.group, label: suggested.label, start: suggested.start, end: suggested.end };
    this.edit((taxonomy, draft) => addRange(taxonomy, draft, range));
    this.selectedRange = range;
  }

  /** Sets or clears a refinement label (e.g. facefuck) for exactly the selected range's span. */
  refineSelected(target: RangeTarget): void {
    const selected = this.selectedRange;
    if (selected === undefined) {
      return;
    }
    this.edit((taxonomy, draft) => refineRange(taxonomy, draft, selected, target));
  }

  selectRange(range: Range | undefined): void {
    this.selectedRange = range;
    if (range !== undefined) {
      this.armLabel(range);
    }
  }

  /** Loops one range; again on the same range goes back to the item. */
  toggleLoop(range: Range): void {
    if (this.loopedRange === range) {
      this.loopedRange = undefined;
      return;
    }
    this.selectedRange = range;
    this.loopedRange = range;
    this.handle?.seek(this.itemStart + range.start);
    this.handle?.play();
  }

  /** Makes a label the one ranges are drawn for: focuses its group and touches it. */
  armLabel(target: RangeTarget): void {
    this.focusedGroupId = target.group;
    this.lastTouchedLabel = { ...this.lastTouchedLabel, [target.group]: target.label };
  }

  cancelRange(): void {
    this.openRanges = [];
    this.selectedRange = undefined;
    this.loopedRange = undefined;
  }

  private deleteSelectedOrClear(): void {
    const selected = this.selectedRange;
    if (selected !== undefined && this.draft.ranges.includes(selected)) {
      this.deleteRange(selected);
      return;
    }
    this.clearFocusedGroup();
  }

  // --- saving and moving on ------------------------------------------------------------

  async save(status: AnnotationStatus): Promise<void> {
    if (this.taxonomy === undefined || this.item === undefined || this.saving || this.loading) {
      return;
    }
    if (status === 'labeled' && this.problems.length > 0) {
      this.say('Fix the problems listed under the groups first');
      return;
    }
    const input = buildAnnotationInput(this.taxonomy, this.draft, status);
    this.saving = true;
    this.serverProblems = [];
    try {
      await this.ctx.api.put(`${apiItemPath(this.projectId(), this.item.id)}/annotation`, input);
      this.loadedFingerprint = fingerprintOf(this.taxonomy, this.draft);
      await this.openNext(this.item.id);
    } catch (failure) {
      this.serverProblems = problemsOf(failure);
    } finally {
      this.saving = false;
    }
  }

  private async openNext(afterItemId: string): Promise<void> {
    const query = new URLSearchParams({ after: afterItemId });
    const next = await this.ctx.api.get<{ item?: ItemView; pending: number }>(
      `/projects/${encodeURIComponent(this.projectId())}/queue/next?${query}`,
    );
    if (next.item === undefined) {
      this.ctx.toasts.push('Queue finished: nothing pending is left', 'success');
      this.ctx.router.navigate(queuePath(this.projectId()));
      return;
    }
    this.ctx.router.navigate(labelPath(this.projectId(), next.item.item.id));
  }

  /** Previous (-1) or next (+1) scene of the same video. */
  openNeighbour(offset: 1 | -1): void {
    let neighbour = this.detail?.previous;
    if (offset === 1) {
      neighbour = this.detail?.next;
    }
    if (neighbour === undefined) {
      this.say('There is no scene in that direction');
      return;
    }
    this.ctx.router.navigate(labelPath(this.projectId(), neighbour.item.id));
  }

  leave(): void {
    this.ctx.router.navigate(queuePath(this.projectId()));
  }

  // --- keys ----------------------------------------------------------------------------

  handleKey(press: KeyPress): LabelAction | undefined {
    const labels = this.keyedLabelsOfFocusedGroup();
    const afterLeader = this.leaderPending;
    this.endLeader();
    const action = actionForKey(pressOf(press, { afterLeader }), labels, settings.keymap);
    if (action === undefined) {
      return undefined;
    }
    if (press.repeat !== true || isRepeatable(action)) {
      this.perform(action);
    }
    return action;
  }

  private keyedLabelsOfFocusedGroup() {
    const group = this.focusedGroup;
    if (group === undefined) {
      return [];
    }
    return offeredLabels(group, this.draft).map((label) => ({ id: label.id, hotkey: label.hotkey }));
  }

  perform(action: LabelAction): void {
    const simple: Partial<Record<LabelAction['kind'], () => void>> = {
      togglePlay: () => this.togglePlay(),
      save: () => void this.save('labeled'),
      skip: () => void this.save('skipped'),
      clearGroup: () => this.deleteSelectedOrClear(),
      acceptProposals: () => this.acceptSuggestions(),
      copyPrevious: () => this.copyPrevious(),
      trimStart: () => this.setEdge('start'),
      trimEnd: () => this.setEdge('end'),
      toggleMuted: () => this.toggleMuted(),
      toggleReviewed: () => this.toggleFocusedReviewed(),
      escape: () => this.cancelRange(),
      search: () => (this.searchOpen = true),
      wholeItem: () => this.wholeItem(),
      leader: () => this.startLeader(),
      acceptHere: () => void this.acceptSuggestionsHere(),
    };
    simple[action.kind]?.();
    this.performWithArgument(action);
  }

  private performWithArgument(action: LabelAction): void {
    if (action.kind === 'focusGroup') {
      this.moveFocus(action.offset);
    }
    if (action.kind === 'toggleLabel') {
      this.toggleFocusedLabel(action.labelId);
    }
    if (action.kind === 'seek') {
      this.seekBy(action.direction * settings.value.seekSeconds);
    }
    if (action.kind === 'stepFrames') {
      this.stepFrames(action.direction * this.framesPerStep(action.jump));
    }
    if (action.kind === 'seekToEdge') {
      this.seekToSceneEdge(action.edge);
    }
    if (action.kind === 'zoom') {
      this.zoomTimeline(action.direction);
    }
    if (action.kind === 'neighbour') {
      this.openNeighbour(action.offset);
    }
  }

  private framesPerStep(jump: boolean): number {
    if (jump) {
      return settings.value.frameJump;
    }
    return 1;
  }

  // --- leader --------------------------------------------------------------------------

  private startLeader(): void {
    this.leaderPending = true;
    clearTimeout(this.leaderTimer);
    this.leaderTimer = setTimeout(() => this.endLeader(), LEADER_WINDOW_MS);
  }

  private endLeader(): void {
    this.leaderPending = false;
    clearTimeout(this.leaderTimer);
  }

  // --- notices -------------------------------------------------------------------------

  private say(message: string): void {
    this.notice = message;
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => (this.notice = ''), NOTICE_LIFETIME_MS);
  }

  dispose(): void {
    clearTimeout(this.noticeTimer);
    clearTimeout(this.leaderTimer);
    this.loadCounter += 1;
    this.resetLive();
  }

  // --- live suggestions ------------------------------------------------------------------

  private resetLive(): void {
    clearTimeout(this.liveTimer);
    this.liveAbort?.abort();
    this.liveCounter += 1;
    this.liveSuggestion = undefined;
    this.liveUpdating = false;
    this.lastLiveRequest = '';
    this.autoAdded = emptyAutoAdded();
    this.autoOffered = emptyAutoAdded();
  }

  private scheduleLive(): void {
    if (this.project?.liveSuggestions === undefined || this.item === undefined) {
      return;
    }
    clearTimeout(this.liveTimer);
    this.liveTimer = setTimeout(() => void this.askLive(), LIVE_DELAY_MS);
  }

  /** Asks for the whole scene again, unless what the person labeled did not change since the last ask. */
  private async askLive(): Promise<void> {
    const url = this.project?.liveSuggestions;
    const item = this.item;
    if (url === undefined || item === undefined) {
      return;
    }
    const annotation = personsAnnotation(this.draft, this.autoAdded);
    const request = JSON.stringify({ item: item.id, annotation });
    if (request === this.lastLiveRequest) {
      return;
    }
    this.lastLiveRequest = request;
    this.liveAbort?.abort();
    this.liveAbort = new AbortController();
    this.liveCounter += 1;
    const thisRequest = this.liveCounter;
    this.liveUpdating = true;
    const answer = await this.postLive(url, item.id, annotation, this.liveAbort.signal);
    if (thisRequest !== this.liveCounter) {
      return;
    }
    this.liveUpdating = false;
    if (answer === undefined) {
      this.lastLiveRequest = '';
      return;
    }
    this.liveSuggestion = answer;
    this.addConfident(answer);
  }

  private async postLive(url: string, itemId: string, annotation: LiveAnnotation, signal: AbortSignal): Promise<Suggestion | undefined> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item: itemId, annotation }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(LIVE_SCENE_TIMEOUT_MS)]),
      });
      if (!response.ok) {
        return undefined;
      }
      const body = (await response.json()) as Omit<Suggestion, 'itemId'>;
      return { ...body, itemId, source: 'live' };
    } catch {
      return undefined;
    }
  }

  /** Labels the model is at least `autoAcceptThreshold` sure of go into the draft as auto-added. */
  private addConfident(suggestion: Suggestion): void {
    const threshold = settings.value.autoAcceptThreshold;
    if (this.taxonomy === undefined || this.loading || threshold > 1) {
      return;
    }
    const additions = confidentAdditions(this.taxonomy, this.draft, suggestion, threshold, this.autoOffered);
    const count = additions.values.length + additions.ranges.length;
    if (count === 0) {
      return;
    }
    const before = this.draft;
    let next = before;
    for (const addition of additions.values) {
      next = toggleLabel(this.taxonomy, next, addition.group, addition.label);
    }
    for (const range of additions.ranges) {
      next = addRange(this.taxonomy, next, range);
    }
    this.draft = next;
    this.rememberAutoAdded(before, next);
    this.say(addedMessage(count));
  }

  /** Everything the additions put in the draft (refinement parents included) counts as auto-added. */
  private rememberAutoAdded(before: Draft, after: Draft): void {
    const previousRanges = new Set(before.ranges.map(rangeKey));
    for (const range of after.ranges) {
      const key = rangeKey(range);
      if (!previousRanges.has(key)) {
        this.autoAdded.ranges.add(key);
        this.autoOffered.ranges.add(key);
      }
    }
    for (const [groupId, labelIds] of Object.entries(after.values)) {
      for (const labelId of labelIds) {
        if (!valuesOfGroup(before, groupId).includes(labelId)) {
          this.autoAdded.values.add(valueKey(groupId, labelId));
          this.autoOffered.values.add(valueKey(groupId, labelId));
        }
      }
    }
  }
}

