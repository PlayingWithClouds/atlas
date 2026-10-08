import type { Context } from "@neoworks/extension-system";
import { parseSpanRef } from "@atlas/contracts";
import type { Item, Session } from "@atlas/contracts";
import type { ModelProvider } from "@atlas/contracts/server";
import { unusedAtoms } from "./plan";
import type { SpanPlan } from "./plan";

const META_KEY = "media-video";

type FingerprintsByVideo = Record<string, string>;

function fingerprintsOf(session: Session): FingerprintsByVideo {
  const own = session.meta[META_KEY] as { segments?: FingerprintsByVideo } | undefined;
  if (own === undefined || own.segments === undefined) {
    return {};
  }
  return own.segments;
}

export function storedFingerprint(session: Session, videoRef: string): string | undefined {
  return fingerprintsOf(session)[videoRef];
}

/** Re-reads the session first so concurrent meta writers (playback flag) are not clobbered. */
export function storeFingerprint(ctx: Context, sessionId: string, videoRef: string, fingerprint: string): void {
  const session = ctx.items.getSession(sessionId) as Session;
  const own = (session.meta[META_KEY] || {}) as Record<string, unknown>;
  const segments = { ...fingerprintsOf(session), [videoRef]: fingerprint };
  ctx.items.updateSession(sessionId, { meta: { ...session.meta, [META_KEY]: { ...own, segments } } });
}

/** Best effort: a provider without a working "forget" just keeps the stale rows. */
export async function forgetQuietly(provider: ModelProvider | undefined, projectId: string, refs: string[]): Promise<void> {
  if (provider === undefined || refs.length === 0) {
    return;
  }
  try {
    await provider.forget(projectId, refs);
  } catch (error) {
    // Stale vectors cost pool size, not correctness.
  }
}

function untouchedClipsOf(ctx: Context, sessionId: string, videoRef: string): Item[] {
  return ctx.items
    .list(sessionId, { status: "pending" })
    .filter((item) => item.span !== undefined && parseSpanRef(item.ref).ref === videoRef);
}

/**
 * Deletes the video's untouched clips and forgets their vectors, which are keyed by a ref that
 * is about to stop existing. Clips the new plan cuts at the same range stay: deleting one only
 * to re-add it would throw away its poster and its embedding.
 */
export async function dropUnlabeled(
  ctx: Context,
  provider: ModelProvider | undefined,
  session: Session,
  videoRef: string,
  planned: SpanPlan[],
): Promise<number> {
  const keep = new Set(planned.map((span) => span.ref));
  const dropped = untouchedClipsOf(ctx, session.id, videoRef).filter((item) => !keep.has(item.ref));
  for (const item of dropped) {
    ctx.items.remove(item.id);
  }
  if (dropped.length > 0) {
    ctx.items.compact(session.id);
  }
  await forgetQuietly(provider, session.projectId, dropped.map((item) => item.ref));
  return dropped.length;
}

/**
 * Reacts to a segment node whose settings changed since this video was cut. Every boundary
 * moves, so untouched clips are dropped to make room while labeled and skipped clips stay:
 * a threshold tweak must not undo human work. A first cut only records the fingerprint.
 */
export async function resegment(
  ctx: Context,
  provider: ModelProvider | undefined,
  session: Session,
  videoRef: string,
  fingerprint: string,
  planned: SpanPlan[],
): Promise<void> {
  const previous = storedFingerprint(session, videoRef);
  if (previous === fingerprint) {
    return;
  }
  if (previous !== undefined) {
    const dropped = await dropUnlabeled(ctx, provider, session, videoRef, planned);
    if (dropped > 0) {
      ctx.notifications.persist({
        key: `segment:${session.id}`,
        message: `Re-segmenting "${session.label}": dropped ${dropped} unlabeled clips`,
        sessionId: session.id,
        level: "info",
      });
    }
  }
  storeFingerprint(ctx, session.id, videoRef, fingerprint);
}

/** Drops the throwaway embeddings of atoms that were merged away. */
export async function forgetUnusedAtoms(
  provider: ModelProvider | undefined,
  projectId: string,
  atoms: SpanPlan[],
  spans: SpanPlan[],
): Promise<void> {
  await forgetQuietly(provider, projectId, unusedAtoms(atoms, spans).map((atom) => atom.ref));
}
