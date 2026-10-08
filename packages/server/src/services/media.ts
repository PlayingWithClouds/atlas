import type { Item, Span } from "@atlas/contracts";
import { parseSpanRef } from "@atlas/contracts";
import type { MediaDescriptor, SourcesService } from "@atlas/contracts/server";

/** The stored ref minus any span fragment; what the owning source understands. */
export function sourceRefOf(item: Item): string {
  return parseSpanRef(item.ref).ref;
}

/** Builds what a model provider needs to read an item's bytes through its owning source. */
export async function describeItem(sources: SourcesService, item: Item): Promise<MediaDescriptor> {
  const location = await sources.locate(item);
  const descriptor: MediaDescriptor = { ref: item.ref, mediaKind: item.mediaKind, location };
  if (item.span) {
    descriptor.span = item.span as Span;
  }
  return descriptor;
}

export function describeItems(sources: SourcesService, items: Item[]): Promise<MediaDescriptor[]> {
  return Promise.all(items.map((item) => describeItem(sources, item)));
}
