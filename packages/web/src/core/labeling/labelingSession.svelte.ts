import { itemLength, validateAnnotation } from '@atlas/contracts';
import type { AnnotationStatus, Group, ItemDetail, ItemView, Project, Range } from '@atlas/contracts';
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
import { actionForKey } from './keyboardMap';
import type { KeyPress, LabelAction } from './keyboardMap';
import { MIN_RANGE_SECONDS, addRange, closePending, deleteRange, effectiveSpan, findPending, isSameSpan, itemTimeOf, refineRange, replaceRange, restartPending, stepRange, togglePending, trimEdge } from './ranges';
import type { PendingRange, RangeTarget } from './ranges';
import { acceptProposals, chooseSuggestion } from './suggestions';
import { labelTracks, rangeBetween } from './timeline';
import type { SuggestedRange } from './timeline';

const NOTICE_LIFETIME_MS = 4000;

/** Holding a key must not save, skip or toggle over and over; moving and seeking may repeat. */
function isRepeatable(action: LabelAction): boolean {
  return action.kind === 'seek' || action.kind === 'stepFrames' || action.kind === 'focusGroup';
}

/** Everything the labeling screen knows and can do for one item at a time. */
export class LabelingSession {
  project = $state.raw<Project | undefined>(undefined);
  detail = $state.raw<ItemDetail | undefined>(undefined);
  draft = $state.raw<Draft>(emptyDraft());
  focusedGroupId = $state<string | undefined>(undefined);
  /** The label search box at the top of the panel (/). */
  searchOpen = $state(false);
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
    this.openRanges = [];
    this.selectedRange = undefined;
    this.loopedRange = undefined;
    this.serverProblems = [];
    this.lastTouchedLabel = {};
    this.focusedGroupId = this.focusable[0]?.id;
    this.restartPlayback(sameAsset);
  }

  /** A new video loads itself paused at its span start; the same video just jumps to the new scene, paused. */
  private restartPlayback(sameAsset: boolean): void {
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

  rangeKey(): void {
    const group = this.focusedGroup;
    if (group === undefined || this.asset === undefined || this.asset.kind !== 'video') {
      this.say('Ranges need a video and a focused group');
      return;
    }
    const labelId = this.focusedLabelId(group);
    if (labelId === undefined) {
      this.say(`Pick a label in "${group.label}" first, then press R for its range`);
      return;
    }
    const target = { group: group.id, label: labelId };
    const time = itemTimeOf(this.currentTime(), this.itemStart, this.length);
    const step = stepRange(findPending(this.openRanges, target), target, time);
    if (step.problem !== undefined) {
      this.say(step.problem);
    }
    const others = this.openRanges.filter((pending) => pending.group !== target.group || pending.label !== target.label);
    if (step.pending !== undefined) {
      this.openRanges = [...others, step.pending];
    }
    if (step.range !== undefined) {
      const range = step.range;
      this.openRanges = others;
      this.edit((taxonomy, draft) => addRange(taxonomy, draft, range));
    }
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

  /** Shift+F: the open labels hold for the whole item instead of a range. */
  wholeItem(): void {
    if (this.openRanges.length === 0) {
      this.say('Start a label with / first, then Shift+F makes it hold for the whole scene');
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
    const action = actionForKey(press, labels);
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
      range: () => this.rangeKey(),
      toggleMore: () => this.toggleMore(),
      toggleMuted: () => this.toggleMuted(),
      toggleReviewed: () => this.toggleFocusedReviewed(),
      escape: () => this.cancelRange(),
      search: () => (this.searchOpen = true),
      wholeItem: () => this.wholeItem(),
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
      this.seekBy(action.seconds);
    }
    if (action.kind === 'stepFrames') {
      this.stepFrames(action.count);
    }
    if (action.kind === 'neighbour') {
      this.openNeighbour(action.offset);
    }
  }

  // --- notices -------------------------------------------------------------------------

  private say(message: string): void {
    this.notice = message;
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => (this.notice = ''), NOTICE_LIFETIME_MS);
  }

  dispose(): void {
    clearTimeout(this.noticeTimer);
    this.loadCounter += 1;
  }
}

