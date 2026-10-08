import type { Annotation, Item, Project, WorkItem } from "@atlas/contracts";
import type { ItemsService, ModelProvider, ModelsService, SourcesService } from "@atlas/contracts/server";

/** The core services the model nodes read; injected so tests can pass stubs. */
export interface ModelNodeServices {
  items: ItemsService;
  models: ModelsService;
  sources: SourcesService;
}

export const TAG_PRIMITIVE = "tag";

export function projectUsesTags(project: Project): boolean {
  return project.config.primitives.includes(TAG_PRIMITIVE);
}

export function providerFor(services: ModelNodeServices, project: Project): ModelProvider {
  return services.models.forProject(project);
}

export function refsOf(items: WorkItem[]): string[] {
  return items.map((item) => item.ref);
}

/** The stored rows behind a node's input stream; items that vanished meanwhile are dropped. */
export function storedItemsOf(services: ModelNodeServices, items: WorkItem[]): Item[] {
  const stored: Item[] = [];
  for (const workItem of items) {
    const item = services.items.get(String(workItem.itemId));
    if (item !== undefined) {
      stored.push(item);
    }
  }
  return stored;
}

/** The class labels carried by an item's tag annotations. */
export function tagLabelsOf(annotations: Annotation[]): string[] {
  const labels: string[] = [];
  for (const annotation of annotations) {
    if (annotation.type !== TAG_PRIMITIVE) {
      continue;
    }
    const value = annotation.value.labels;
    if (Array.isArray(value)) {
      labels.push(...value.map(String));
    }
  }
  return labels;
}

export function tagAnnotation(labels: string[]): Annotation {
  return { type: TAG_PRIMITIVE, value: { labels } };
}

export const TAG_PRIMITIVE_MISSING_MESSAGE =
  "This project has no tag primitive, so the node left the items untouched";
