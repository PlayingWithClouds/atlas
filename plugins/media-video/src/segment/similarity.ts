import type { MediaDescriptor, MediaLocation, ModelProvider } from "@atlas/contracts/server";
import { EMBED_BATCH_SIZE, batchesOf, embedDescriptors } from "../nodeSupport";
import type { SpanPlan } from "./plan";

export interface AtomComparison {
  /** scores[i] is the similarity between atoms[i] and atoms[i+1]; empty when nothing was compared. */
  scores: number[];
  /** Atoms the provider now holds vectors for; spans with the same ref need no second embed. */
  embeddedRefs: Set<string>;
  note: string;
}

/**
 * Scores every adjacent pair in refs. Batches overlap by one clip so the pair that spans a
 * batch boundary is still scored: a batch of n refs answers n-1 pairs, and the next batch
 * restarts at the ref the last one ended on.
 */
export async function similarityChain(
  provider: ModelProvider,
  projectId: string,
  refs: string[],
  onBatch: (scored: number) => void,
): Promise<number[]> {
  const scores: number[] = [];
  for (let start = 0; start + 1 < refs.length; start += EMBED_BATCH_SIZE - 1) {
    const end = Math.min(start + EMBED_BATCH_SIZE, refs.length);
    const batch = await provider.similarity(projectId, refs.slice(start, end));
    // A short answer would silently shift every later boundary by one clip.
    if (batch.length !== end - start - 1) {
      throw new Error(`similarity returned ${batch.length} scores for ${end - start} clips`);
    }
    scores.push(...batch);
    onBatch(scores.length);
  }
  return scores;
}

function descriptorOf(atom: SpanPlan, location: MediaLocation): MediaDescriptor {
  return { ref: atom.ref, mediaKind: "video", location, span: { start: atom.start, end: atom.end } };
}

async function embedAtoms(
  provider: ModelProvider,
  projectId: string,
  atoms: SpanPlan[],
  location: MediaLocation,
): Promise<Set<string>> {
  const embedded = new Set<string>();
  for (const batch of batchesOf(atoms, EMBED_BATCH_SIZE)) {
    const refs = await embedDescriptors(provider, projectId, batch.map((atom) => descriptorOf(atom, location)));
    refs.forEach((ref) => embedded.add(ref));
  }
  return embedded;
}

/**
 * Embeds the candidate clips and reports how alike each neighbouring pair is. Every failure
 * degrades to "no scores", which merges nothing and leaves the detected cuts as the boundaries,
 * so a missing or broken model costs merging, not the run.
 */
export async function compareAtoms(
  provider: ModelProvider | undefined,
  projectId: string,
  atoms: SpanPlan[],
  location: MediaLocation,
  onScored: (scored: number, total: number) => void,
): Promise<AtomComparison> {
  const none = { scores: [], embeddedRefs: new Set<string>() };
  if (provider === undefined) {
    return { ...none, note: "no model plugin, so similar neighbours were not merged" };
  }
  const embeddedRefs = await embedAtoms(provider, projectId, atoms, location);
  if (embeddedRefs.size < atoms.length) {
    return { ...none, embeddedRefs, note: "clips could not be embedded, so similar neighbours were not merged" };
  }
  try {
    const refs = atoms.map((atom) => atom.ref);
    const scores = await similarityChain(provider, projectId, refs, (scored) => onScored(scored, atoms.length - 1));
    return { scores, embeddedRefs, note: "" };
  } catch (error) {
    return { ...none, embeddedRefs, note: "clips could not be compared, so similar neighbours were not merged" };
  }
}
