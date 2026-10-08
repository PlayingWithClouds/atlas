import type { Annotation, Item } from "@atlas/contracts";
import type { ApiClient } from "@atlas/contracts/web";

export type GridSort = "natural" | "uncertainty";

export interface ItemDetail {
  item: Item;
  suggestions: Record<string, number>;
  threshold: number;
}

export interface NextItem {
  item?: Item;
  done: boolean;
  waiting: boolean;
}

interface ModelSummary {
  id: string;
  capabilities: { textSearch: boolean };
}

export function listItems(api: ApiClient, sessionId: string, unfinishedOnly: boolean, sort: GridSort): Promise<Item[]> {
  const query: string[] = [];
  if (unfinishedOnly) {
    query.push("status=pending");
  }
  if (sort === "uncertainty") {
    query.push("sort=uncertainty");
  }
  const suffix = query.length > 0 ? `?${query.join("&")}` : "";
  return api.get<Item[]>(`/sessions/${sessionId}/items${suffix}`);
}

export function describeItem(api: ApiClient, itemId: string): Promise<ItemDetail> {
  return api.get<ItemDetail>(`/items/${itemId}`);
}

export function nextItem(api: ApiClient, sessionId: string): Promise<NextItem> {
  return api.get<NextItem>(`/sessions/${sessionId}/next`);
}

export function confirmAnnotations(api: ApiClient, itemId: string, annotations: Annotation[]): Promise<Item> {
  return api.post<Item>(`/items/${itemId}/label`, { annotations });
}

export function skipItem(api: ApiClient, itemId: string): Promise<Item> {
  return api.post<Item>(`/items/${itemId}/skip`);
}

export function deleteItem(api: ApiClient, itemId: string): Promise<unknown> {
  return api.delete(`/items/${itemId}`);
}

export async function findDuplicateIds(api: ApiClient, sessionId: string): Promise<string[]> {
  const groups = await api.get<{ keep: string; duplicates: string[] }[]>(`/sessions/${sessionId}/duplicates`);
  return groups.flatMap((group) => group.duplicates);
}

/** Item ids matching a text query, best match first. */
export async function searchItemIds(api: ApiClient, sessionId: string, query: string): Promise<string[]> {
  const hits = await api.get<{ itemId: string }[]>(`/sessions/${sessionId}/search?q=${encodeURIComponent(query)}`);
  return hits.map((hit) => hit.itemId);
}

export async function modelSupportsTextSearch(api: ApiClient, modelId: string): Promise<boolean> {
  const models = await api.get<ModelSummary[]>("/models");
  const model = models.find((candidate) => candidate.id === modelId);
  if (!model) {
    return false;
  }
  return model.capabilities.textSearch;
}

export async function announceSession(api: ApiClient, sessionId: string, event: "opened" | "closed"): Promise<void> {
  try {
    await api.post(`/sessions/${sessionId}/${event}`);
  } catch {
    // Presence events are best effort and must never block labeling.
  }
}
