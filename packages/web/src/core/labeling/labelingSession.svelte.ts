import { itemLength, validateAnnotation } from '@atlas/contracts';
import type { AnnotationStatus, Group, ItemDetail, ItemView, Project, Range } from '@atlas/contracts';
import type { PlayerHandle } from '@atlas/contracts/web';
import type { Context } from '@neoworks/extension-system';
import { apiItemPath, labelPath, queuePath } from '../queue/itemLink';
import { messageOf, problemsOf } from '../shared/errors';
import {
  buildAnnotationInput,
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
import { addRange, effectiveSpan, itemTimeOf, removeRange, stepRange, trimEdge } from './ranges';
import type { PendingRange } from './ranges';
import { acceptProposals, chooseSuggestion } from './suggestions';

const NOTICE_LIFETIME_MS = 4000;

/** Holding a key must not save, skip or toggle over and over; moving and seeking may repeat. */
function isRepeatable(action: LabelAction): boolean {
  return action.kind === 'seek' || action.kind === 'focusGroup';
}

/** Everything the labeling screen knows and can do for one item at a time. */
export class LabelingSession {
  project = $state.raw<Project | undefined>(undefined);
  detail = $state.raw<ItemDetail | undefined>(undefined);
  draft = $state.raw<Draft>(emptyDraft());
  focusedGroupId = $state<string | undefined>(undefined);
  pendingRange = $state.raw<PendingRange | undefined>(undefined);
  playhead = $state(0);
  loading = $state(true);
  saving = $state(false);
  loadError = $state('');
  serverProblems = $state.raw<string[]>([]);
  notice = $state('');
  handle: PlayerHandle | undefined;

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
    this.pendingRange = undefined;
    this.serverProblems = [];
    this.lastTouchedLabel = {};
    this.focusedGroupId = this.focusable[0]?.id;
    this.restartPlayback(sameAsset);
  }

  /** A new video loads itself from its span start; the same video just jumps to the new scene. */
  private restartPlayback(sameAsset: boolean): void {
    if (!sameAsset || this.handle === undefined || this.playSpan === undefined) {
      return;
    }
    this.handle.seek(this.playSpan.start);
    this.handle.play();
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
    this.edit((taxonomy, draft) => toggleLabel(taxonomy, draft, group, labelId));
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

  private focusedLabelId(group: Group): string | undefined {
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
    const time = itemTimeOf(this.currentTime(), this.itemStart, this.length);
    this.applyRangeStep(stepRange(this.pendingRange, { group: group.id, label: labelId }, time));
  }

  private applyRangeStep(step: ReturnType<typeof stepRange>): void {
    if (step.problem !== undefined) {
      this.say(step.problem);
    }
    this.pendingRange = step.pending;
    if (step.range !== undefined) {
      const range = step.range;
      this.edit((taxonomy, draft) => addRange(taxonomy, draft, range));
    }
  }

  deleteRange(range: Range): void {
    this.edit((_taxonomy, draft) => removeRange(draft, range));
  }

  cancelRange(): void {
    this.pendingRange = undefined;
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
      clearGroup: () => this.clearFocusedGroup(),
      acceptProposals: () => this.acceptSuggestions(),
      copyPrevious: () => this.copyPrevious(),
      trimStart: () => this.trim('start'),
      trimEnd: () => this.trim('end'),
      range: () => this.rangeKey(),
      toggleMore: () => this.toggleMore(),
      toggleMuted: () => this.toggleMuted(),
      toggleReviewed: () => this.toggleFocusedReviewed(),
      escape: () => this.cancelRange(),
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

