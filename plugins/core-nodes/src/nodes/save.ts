import type { Annotation, Item, WorkItem } from "@atlas/contracts";
import type { ItemsService, LabelingService, NodeType } from "@atlas/contracts/server";
import { optionParam, stringParam } from "../params";

function isAnnotation(value: unknown): value is Annotation {
  const candidate = value as { type?: unknown; value?: unknown };
  if (typeof candidate !== "object" || candidate === null) {
    return false;
  }
  return typeof candidate.type === "string" && typeof candidate.value === "object" && candidate.value !== null;
}

/** Malformed annotation payloads skip the item rather than failing the run. */
function annotationsOf(workItem: WorkItem): Annotation[] | undefined {
  if (!Array.isArray(workItem.annotations) || !workItem.annotations.every(isAnnotation)) {
    return undefined;
  }
  return workItem.annotations;
}

function needsSaving(stored: Item, annotations: Annotation[], mode: string): boolean {
  if (mode === "propose" && stored.status !== "pending") {
    return false;
  }
  const unchanged = JSON.stringify(stored.annotations) === JSON.stringify(annotations);
  return !(unchanged && (mode === "propose" || stored.status === "labeled"));
}

async function saveAnnotations(
  services: { items: ItemsService; labeling: LabelingService },
  stored: Item,
  annotations: Annotation[],
  mode: string,
): Promise<void> {
  if (mode === "confirm") {
    await services.labeling.confirm(stored.id, annotations);
    return;
  }
  services.items.propose(stored.id, annotations);
}

export function createSaveNode(services: { items: ItemsService; labeling: LabelingService }): NodeType {
  return {
    type: "save",
    plugin: "core-nodes",
    label: "Save",
    description: "Persist node results (annotations, embedded flag) onto the session's items",
    input: "items",
    output: "items",
    params: [optionParam("mode", "Annotations as", ["propose", "confirm"], "propose")],
    async run(items, context) {
      const mode = stringParam(context.params, "mode", "propose");
      const storedByRef = new Map(services.items.list(context.session.id).map((stored) => [stored.ref, stored]));
      const newlyEmbeddedIds: string[] = [];
      for (const workItem of items) {
        const stored = storedByRef.get(workItem.ref);
        if (stored === undefined) {
          continue;
        }
        if (workItem.embedded === true && !stored.embedded) {
          newlyEmbeddedIds.push(stored.id);
        }
        const annotations = annotationsOf(workItem);
        if (annotations !== undefined && needsSaving(stored, annotations, mode)) {
          await saveAnnotations(services, stored, annotations, mode);
        }
      }
      if (newlyEmbeddedIds.length > 0) {
        services.items.setEmbedded(newlyEmbeddedIds, true);
        await services.labeling.backfill(context.session.id);
      }
      return { items };
    },
  };
}
