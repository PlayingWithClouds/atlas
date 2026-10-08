import { spanRef } from "@atlas/contracts";

/** One planned temporal clip: its time range and media-fragment ref. */
export interface SpanPlan {
  ref: string;
  start: number;
  end: number;
}

interface ShotRange {
  start: number;
  end: number;
}

/** A run of adjacent atoms that will become one clip, held as indices into the atom list. */
interface AtomGroup {
  first: number;
  last: number;
}

function planOf(videoRef: string, start: number, end: number): SpanPlan {
  return { ref: spanRef(videoRef, { start, end }), start, end };
}

/**
 * Lays out fixed windows of `window` seconds every `stride` seconds across the duration. The
 * final window is clamped to the duration. Non-positive inputs yield no spans.
 */
export function planSpans(videoRef: string, duration: number, window: number, stride: number): SpanPlan[] {
  if (videoRef === "" || duration <= 0 || window <= 0 || stride <= 0) {
    return [];
  }
  const spans: SpanPlan[] = [];
  for (let start = 0; start < duration; start += stride) {
    spans.push(planOf(videoRef, start, Math.min(start + window, duration)));
  }
  return spans;
}

/**
 * Turns cut timestamps into the ranges between them. Cuts outside the video, and cuts that do
 * not advance past the previous one, are ignored: ffmpeg reports a long transition as several
 * frames in a row, and each extra one would open an empty shot.
 */
export function shotRanges(duration: number, cuts: number[]): ShotRange[] {
  const shots: ShotRange[] = [];
  let start = 0;
  for (const cut of cuts) {
    if (cut <= start || cut >= duration) {
      continue;
    }
    shots.push({ start, end: cut });
    start = cut;
  }
  shots.push({ start, end: duration });
  return shots;
}

/**
 * Splits one shot into equal parts no longer than maxLength. Equal parts rather than
 * maxLength-sized ones plus a remainder: a 4.1s shot should read as two halves, not as a 4s
 * clip trailed by a 0.1s sliver nothing can be labeled from.
 */
export function subdivide(videoRef: string, shot: ShotRange, maxLength: number): SpanPlan[] {
  const length = shot.end - shot.start;
  if (length <= 0) {
    return [];
  }
  // The epsilon keeps a shot that is exactly maxLength long from rounding up to two parts.
  const parts = Math.max(Math.ceil(length / maxLength - 1e-9), 1);
  const step = length / parts;
  const atoms: SpanPlan[] = [];
  for (let part = 0; part < parts; part++) {
    const start = shot.start + part * step;
    atoms.push(planOf(videoRef, start, Math.min(start + step, shot.end)));
  }
  return atoms;
}

/**
 * The smallest clips scene mode will consider: the video split at every detected cut, with any
 * piece longer than maxLength divided further. An atom never straddles a cut or outlives the
 * window.
 */
export function planAtoms(videoRef: string, duration: number, cuts: number[], maxLength: number): SpanPlan[] {
  if (videoRef === "" || duration <= 0 || maxLength <= 0) {
    return [];
  }
  const atoms: SpanPlan[] = [];
  for (const shot of shotRanges(duration, cuts)) {
    atoms.push(...subdivide(videoRef, shot, maxLength));
  }
  return atoms;
}

/**
 * The similarity across the gap after atom `index`, or 0 where the model gave no answer.
 * Zero reads as "not the same content", which leaves the boundary where detection put it.
 */
export function boundaryScore(scores: number[], index: number): number {
  if (index < 0 || index >= scores.length) {
    return 0;
  }
  return scores[index];
}

function groupLength(atoms: SpanPlan[], group: AtomGroup): number {
  return atoms[group.last].end - atoms[group.first].start;
}

function fitsTogether(atoms: SpanPlan[], left: AtomGroup, right: AtomGroup, maxLength: number): boolean {
  return atoms[right.last].end - atoms[left.first].start <= maxLength;
}

/**
 * Walks the atoms in playback order, extending the current group while the next atom is the
 * same content and the group stays inside maxLength. This re-joins angle changes within one
 * act, and keeps a position change under a continuous take apart.
 */
function joinSimilar(atoms: SpanPlan[], scores: number[], merge: number, maxLength: number): AtomGroup[] {
  const groups: AtomGroup[] = [{ first: 0, last: 0 }];
  for (let index = 1; index < atoms.length; index++) {
    const current = groups[groups.length - 1];
    const joinedLength = atoms[index].end - atoms[current.first].start;
    if (merge > 0 && boundaryScore(scores, index - 1) >= merge && joinedLength <= maxLength) {
      current.last = index;
      continue;
    }
    groups.push({ first: index, last: index });
  }
  return groups;
}

/** The neighbour a too-short group should join: the more similar of the two that has room, or -1. */
function absorbTarget(atoms: SpanPlan[], groups: AtomGroup[], scores: number[], index: number, maxLength: number): number {
  let previous = index - 1;
  let next = index + 1;
  if (previous >= 0 && !fitsTogether(atoms, groups[previous], groups[index], maxLength)) {
    previous = -1;
  }
  if (next >= groups.length || !fitsTogether(atoms, groups[index], groups[next], maxLength)) {
    next = -1;
  }
  if (previous < 0 || next < 0) {
    return Math.max(previous, next);
  }
  if (boundaryScore(scores, groups[index].last) > boundaryScore(scores, groups[previous].last)) {
    return next;
  }
  return previous;
}

/** The shortest group still under minLength that has somewhere to go, with its target. */
function shortestAbsorbable(
  atoms: SpanPlan[],
  groups: AtomGroup[],
  scores: number[],
  minLength: number,
  maxLength: number,
): { index: number; target: number } | undefined {
  let found: { index: number; target: number } | undefined;
  let shortest = minLength;
  groups.forEach((group, index) => {
    const length = groupLength(atoms, group);
    if (length >= shortest) {
      return;
    }
    const target = absorbTarget(atoms, groups, scores, index, maxLength);
    if (target < 0) {
      return;
    }
    found = { index, target };
    shortest = length;
  });
  return found;
}

function joinGroups(groups: AtomGroup[], index: number, target: number): AtomGroup[] {
  const left = Math.min(index, target);
  const right = Math.max(index, target);
  const joined = { first: groups[left].first, last: groups[right].last };
  return [...groups.slice(0, left), joined, ...groups.slice(right + 1)];
}

/**
 * Folds groups shorter than minLength into a neighbour, shortest first. A group with nowhere
 * to go without breaking maxLength is left alone: a short clip is a smaller problem than one
 * that runs past the window.
 */
function absorbShort(atoms: SpanPlan[], initial: AtomGroup[], scores: number[], minLength: number, maxLength: number): AtomGroup[] {
  let groups = initial;
  for (;;) {
    const next = shortestAbsorbable(atoms, groups, scores, minLength, maxLength);
    if (next === undefined) {
      return groups;
    }
    groups = joinGroups(groups, next.index, next.target);
  }
}

/**
 * Joins the neighbouring atoms the model reports as the same content, then folds away whatever
 * is left shorter than minLength. `scores[i]` is the similarity between atoms[i] and
 * atoms[i+1]; a missing or short list merges nothing, which is what should happen when the
 * comparison could not run.
 */
export function mergeAtoms(
  videoRef: string,
  atoms: SpanPlan[],
  scores: number[],
  merge: number,
  minLength: number,
  maxLength: number,
): SpanPlan[] {
  if (atoms.length === 0) {
    return [];
  }
  const joined = joinSimilar(atoms, scores, merge, maxLength);
  const groups = absorbShort(atoms, joined, scores, minLength, maxLength);
  return groups.map((group) => planOf(videoRef, atoms[group.first].start, atoms[group.last].end));
}

/** Atoms that were compared but merged away; their throwaway embeddings can be dropped. */
export function unusedAtoms(atoms: SpanPlan[], spans: SpanPlan[]): SpanPlan[] {
  const kept = new Set(spans.map((span) => span.ref));
  return atoms.filter((atom) => !kept.has(atom.ref));
}
