import type { Context } from "@neoworks/extension-system";
import type { Item, Project, Session, WorkItem } from "@atlas/contracts";
import type { MediaDescriptor, ModelProvider } from "@atlas/contracts/server";

/** Both the tray notification and the websocket push are database writes; throttle them. */
export const PROGRESS_EVERY = 8;

export const EMBED_BATCH_SIZE = 16;

export function toWorkItem(item: Item): WorkItem {
  const workItem: WorkItem = {
    ref: item.ref,
    itemId: item.id,
    mediaKind: item.mediaKind,
    status: item.status,
    embedded: item.embedded,
    annotations: item.annotations,
  };
  if (item.span !== undefined) {
    workItem.span = item.span;
  }
  return workItem;
}

export function numberParam(params: Record<string, unknown>, key: string, fallback: number): number {
  const raw = params[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  return raw;
}

/** The stored items behind a node's input stream, in stream order. */
export function storedItemsOf(ctx: Context, workItems: WorkItem[]): Item[] {
  const items: Item[] = [];
  for (const workItem of workItems) {
    const item = ctx.items.get(String(workItem.itemId));
    if (item !== undefined) {
      items.push(item);
    }
  }
  return items;
}

export function isWholeVideo(item: Item): boolean {
  return item.mediaKind === "video" && item.span === undefined;
}

/** The project's model provider, or undefined when it is not loaded. */
export function providerOf(ctx: Context, project: Project): ModelProvider | undefined {
  try {
    return ctx.models.forProject(project);
  } catch (error) {
    return undefined;
  }
}

/** Keeps `session.producing` true while the work runs, so the labeling queue waits for items. */
export async function whileProducing<T>(ctx: Context, sessionId: string, work: () => Promise<T>): Promise<T> {
  ctx.items.updateSession(sessionId, { producing: true });
  try {
    return await work();
  } finally {
    if (ctx.items.getSession(sessionId) !== undefined) {
      ctx.items.updateSession(sessionId, { producing: false });
    }
  }
}

/** Updates the session's single tray notification on every PROGRESS_EVERY-th item and the last. */
export function reportProgress(
  ctx: Context,
  session: Session,
  progressKey: string,
  verb: string,
  done: number,
  total: number,
): void {
  if (done % PROGRESS_EVERY !== 0 && done !== total) {
    return;
  }
  ctx.notifications.persist({
    key: progressKey,
    message: `${verb} "${session.label}": ${done}/${total}`,
    sessionId: session.id,
    level: "info",
  });
}

export function batchesOf<T>(entries: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < entries.length; start += size) {
    batches.push(entries.slice(start, start + size));
  }
  return batches;
}

/** Best effort: a provider that cannot embed leaves the items unembedded, not the run failed. */
export async function embedDescriptors(
  provider: ModelProvider,
  projectId: string,
  descriptors: MediaDescriptor[],
): Promise<string[]> {
  try {
    const result = await provider.embed(projectId, descriptors);
    return result.embedded;
  } catch (error) {
    return [];
  }
}
