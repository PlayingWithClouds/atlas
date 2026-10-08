import { Service } from "@neoworks/extension-system";
import type { Context } from "@neoworks/extension-system";
import { classNamesOf } from "@atlas/contracts";
import type { Annotation, Item, Project } from "@atlas/contracts";
import { HttpError } from "@atlas/contracts/server";
import type { LabelingService, ModelProvider } from "@atlas/contracts/server";
import { describeItems } from "./media";

export class LabelingCore extends Service implements LabelingService {
  static inject = ["items", "projects", "models", "primitives", "notifications", "sources"];

  constructor(ctx: Context) {
    super(ctx, "labeling");
  }

  async confirm(itemId: string, annotations: Annotation[]): Promise<Item> {
    const item = this.requireItem(itemId);
    const project = this.projectOf(item);
    const normalized = this.normalizeAnnotations(annotations, project);
    const labeled = this.ctx.items.setAnnotations(itemId, normalized, "labeled");
    this.ctx.emit("items/labeled", labeled);
    await this.trainQuietly(project, [labeled]);
    return labeled;
  }

  skip(itemId: string): Item {
    const item = this.requireItem(itemId);
    if (item.status === "labeled") {
      return item;
    }
    return this.ctx.items.setAnnotations(itemId, item.annotations, "skipped");
  }

  async next(sessionId: string): Promise<{ item?: Item; done: boolean; waiting: boolean }> {
    const session = this.ctx.items.getSession(sessionId);
    if (!session) {
      throw new HttpError(404, "session not found");
    }
    const pending = this.ctx.items.list(sessionId, { status: "pending" });
    if (pending.length === 0) {
      return { done: !session.producing, waiting: session.producing };
    }
    const item = await this.mostInformative(pending, this.ctx.projects.get(session.projectId) as Project);
    return { item, done: false, waiting: false };
  }

  async suggestions(item: Item): Promise<Record<string, number>> {
    const project = this.projectOf(item);
    const provider = this.ctx.models.get(project.config.model);
    if (!provider) {
      return {};
    }
    try {
      const predictions = await provider.predict(project.id, [item.ref], classNamesOf(project.config));
      const forItem = predictions[item.ref];
      if (!forItem) {
        return {};
      }
      return forItem;
    } catch (error) {
      return {};
    }
  }

  async backfill(sessionId: string): Promise<void> {
    const session = this.ctx.items.getSession(sessionId);
    if (!session) {
      throw new HttpError(404, "session not found");
    }
    const project = this.ctx.projects.get(session.projectId) as Project;
    const labeled = this.ctx.items.list(sessionId, { status: "labeled" });
    await this.trainQuietly(project, labeled);
  }

  // --- internals ---------------------------------------------------------------------

  private requireItem(itemId: string): Item {
    const item = this.ctx.items.get(itemId);
    if (!item) {
      throw new HttpError(404, "item not found");
    }
    return item;
  }

  private projectOf(item: Item): Project {
    const session = this.ctx.items.getSession(item.sessionId);
    if (!session) {
      throw new HttpError(404, "session not found");
    }
    return this.ctx.projects.get(session.projectId) as Project;
  }

  private normalizeAnnotations(annotations: Annotation[], project: Project): Annotation[] {
    const normalized: Annotation[] = [];
    for (const annotation of annotations) {
      const cleaned = this.normalizeOne(annotation, project);
      if (cleaned) {
        normalized.push(cleaned);
      }
    }
    return normalized;
  }

  private normalizeOne(annotation: Annotation, project: Project): Annotation | undefined {
    const primitive = this.ctx.primitives.get(annotation.type);
    if (!primitive) {
      return undefined;
    }
    const value = primitive.normalize(annotation.value, project);
    if (value === null) {
      return undefined;
    }
    return { type: annotation.type, value };
  }

  private isTrainable(project: Project): boolean {
    return project.config.primitives.some((primitiveId) => {
      const primitive = this.ctx.primitives.get(primitiveId);
      return primitive !== undefined && primitive.trainingLabels !== undefined;
    });
  }

  private labelsOf(item: Item): string[] {
    const labels: string[] = [];
    for (const annotation of item.annotations) {
      const primitive = this.ctx.primitives.get(annotation.type);
      if (primitive && primitive.trainingLabels) {
        labels.push(...primitive.trainingLabels(annotation.value));
      }
    }
    return labels;
  }

  private async trainQuietly(project: Project, items: Item[]): Promise<void> {
    const provider = this.ctx.models.get(project.config.model);
    if (!provider || !this.isTrainable(project) || items.length === 0) {
      return;
    }
    const examples = items.map((item) => ({ ref: item.ref, labels: this.labelsOf(item) }));
    await this.embedMissing(provider, project, items);
    try {
      await provider.train(project.id, examples, classNamesOf(project.config));
    } catch (error) {
      this.reportTrainingFailure(project, error);
    }
  }

  /** Providers only train on vectors they already hold, so unembedded labeled items are embedded first. */
  private async embedMissing(provider: ModelProvider, project: Project, items: Item[]): Promise<void> {
    const missing = items.filter((item) => !item.embedded);
    if (missing.length === 0) {
      return;
    }
    try {
      const descriptors = await describeItems(this.ctx.sources, missing);
      const result = await provider.embed(project.id, descriptors);
      const embeddedRefs = new Set(result.embedded);
      const embeddedIds = missing.filter((item) => embeddedRefs.has(item.ref)).map((item) => item.id);
      this.ctx.items.setEmbedded(embeddedIds, true);
    } catch (error) {
      // Training still runs on whatever the provider already holds.
    }
  }

  private reportTrainingFailure(project: Project, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.ctx.notifications.persist({
      key: `train-error:${project.id}`,
      message: `Training failed for project "${project.name}": ${detail}`,
      level: "error",
    });
  }

  private async mostInformative(pending: Item[], project: Project): Promise<Item> {
    const embedded = pending.filter((item) => item.embedded);
    if (embedded.length === 0) {
      return pending[0];
    }
    const provider = this.ctx.models.get(project.config.model);
    if (!provider) {
      return embedded[0];
    }
    return this.firstRanked(provider, project, embedded);
  }

  private async firstRanked(provider: ModelProvider, project: Project, embedded: Item[]): Promise<Item> {
    try {
      const refs = embedded.map((item) => item.ref);
      const ranking = await provider.rank(project.id, refs, classNamesOf(project.config));
      const top = embedded.find((item) => item.ref === ranking.order[0]);
      if (top) {
        return top;
      }
    } catch (error) {
      return embedded[0];
    }
    return embedded[0];
  }
}

export default LabelingCore;
