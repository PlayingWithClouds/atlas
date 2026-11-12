import { Service } from "@neoworks/extension-system";
import type { Context } from "@neoworks/extension-system";
import type { LiveEvent } from "@atlas/contracts";
import type { Dispose, StoreService } from "@atlas/contracts/server";
import { AnnotationsService } from "./annotationsService";
import { AnnotationsTable } from "./annotationsTable";
import { StoreEvents } from "./events";
import { ItemsService } from "./itemsService";
import { ItemViews } from "./itemViews";
import { MediaService } from "./mediaService";
import { MediaTable } from "./mediaTable";
import { STORE_MIGRATIONS, STORE_NAMESPACE } from "./migrations";
import { ModelOverviewQuery } from "./modelOverview";
import { ProjectsService } from "./projectsService";
import { ProjectsTable } from "./projectsTable";
import { SuggestionsTable } from "./suggestionsTable";

/**
 * The labeling store (docs/schema.md): projects, media, annotations, suggestions and the
 * change feed, kept in `<workspace>/store.db`. HTTP routes and webhooks are separate plugins
 * built on it.
 */
export class StoreCore extends Service implements StoreService {
  static inject = ["db"];

  readonly projects: ProjectsService;
  readonly media: MediaService;
  readonly items: ItemsService;
  readonly annotations: AnnotationsService;
  private readonly events: StoreEvents;

  constructor(ctx: Context) {
    super(ctx, "store");
    ctx.db.migrate(STORE_NAMESPACE, STORE_MIGRATIONS);
    const database = ctx.db.database;
    this.events = new StoreEvents((error) => ctx.logger.error(error));
    const projectsTable = new ProjectsTable(database);
    const mediaTable = new MediaTable(database);
    const annotationsTable = new AnnotationsTable(database);
    const suggestionsTable = new SuggestionsTable(database);
    this.projects = new ProjectsService(projectsTable, this.events);
    this.media = new MediaService(
      ctx.db,
      { media: mediaTable, annotations: annotationsTable, suggestions: suggestionsTable },
      this.projects,
      this.events,
    );
    this.items = new ItemsService(
      new ItemViews(database),
      new ModelOverviewQuery(database),
      suggestionsTable,
      this.projects,
    );
    this.annotations = new AnnotationsService(ctx.db, annotationsTable, mediaTable, this.projects, this.events);
  }

  subscribe(listener: (event: LiveEvent) => void): Dispose {
    return this.events.subscribe(listener);
  }
}

export default StoreCore;
