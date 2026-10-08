import { Context } from "@neoworks/extension-system";
import type {
  Annotation,
  Item,
  ItemStatus,
  JobView,
  NotificationView,
  Project,
  ProjectConfig,
  Session,
  WorkspaceConfig,
} from "../../packages/contracts/src/index";
import type {
  Dispose,
  JobHandle,
  ModelProvider,
  NewItem,
  NotificationInput,
  Primitive,
  RouteHandler,
} from "../../packages/contracts/src/server";

export interface RouteCall {
  params?: Record<string, string>;
  body?: unknown;
  query?: string;
}

/** In-memory implementations of the services the workflow layer depends on. */
export interface StubWorld {
  context: Context;
  routes: Map<string, RouteHandler>;
  persisted: NotificationInput[];
  toasts: NotificationInput[];
  savedConfigs: WorkspaceConfig[];
  jobs: { settle(): Promise<void>; submitted: JobView[] };
  calls: { confirm: string[]; skip: string[]; backfill: string[]; rank: string[][] };
  items: Map<string, Item>;
  addProject(config?: Partial<ProjectConfig>): Project;
  addSession(projectId: string): Session;
  addItems(sessionId: string, refs: string[], overrides?: Partial<Item>): Item[];
  callRoute(method: string, pattern: string, options?: RouteCall): Promise<unknown>;
}

function emptyConfig(): WorkspaceConfig {
  return { title: "test", plugins: [], workflows: [], settings: {} };
}

function projectConfig(overrides: Partial<ProjectConfig>): ProjectConfig {
  return {
    primitives: ["tag"],
    labels: { groups: [{ id: "g", label: "G", classes: [{ name: "a" }, { name: "b" }] }] },
    mediaKind: "image",
    model: "stub-model",
    ...overrides,
  };
}

export function createStubWorld(): StubWorld {
  const context = new Context();
  const routes = new Map<string, RouteHandler>();
  const persisted: NotificationInput[] = [];
  const toasts: NotificationInput[] = [];
  const savedConfigs: WorkspaceConfig[] = [];
  const pendingJobs: Promise<void>[] = [];
  const submittedJobs: JobView[] = [];
  const activeJobs = new Set<string>();
  const calls = { confirm: [] as string[], skip: [] as string[], backfill: [] as string[], rank: [] as string[][] };
  const projects = new Map<string, Project>();
  const sessions = new Map<string, Session>();
  const items = new Map<string, Item>();
  let workspaceConfig = emptyConfig();
  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}-${(sequence += 1)}`;

  function setAnnotations(itemId: string, annotations: Annotation[], status: ItemStatus): Item {
    const item = items.get(itemId) as Item;
    const updated = { ...item, annotations, status };
    items.set(itemId, updated);
    return updated;
  }

  const provide = (key: string, value: unknown) => (context as any).provide(key, value);

  provide("workspace", {
    directory: "/tmp/stub",
    cacheDirectory: "/tmp/stub/cache",
    pluginCacheDirectory: () => "/tmp/stub/cache/plugin",
    config: () => workspaceConfig,
    saveConfig: (config: WorkspaceConfig) => {
      workspaceConfig = JSON.parse(JSON.stringify(config));
      savedConfigs.push(workspaceConfig);
    },
  });

  provide("http", {
    port: 0,
    route: (method: string, pattern: string, handler: RouteHandler): Dispose => {
      routes.set(`${method} ${pattern}`, handler);
      return () => routes.delete(`${method} ${pattern}`);
    },
  });

  provide("live", { provideState: () => () => {}, notify: () => {}, broadcast: () => {} });

  provide("notifications", {
    persist: (input: NotificationInput): NotificationView => {
      persisted.push(input);
      return { id: nextId("note"), message: input.message, level: "info", created: "" };
    },
    toast: (input: NotificationInput) => toasts.push(input),
    list: () => [],
    dismiss: () => {},
    clear: () => {},
  });

  provide("jobs", {
    submit: (spec: { type: string; sessionId?: string; extra?: Record<string, unknown> }, run: (job: JobHandle) => Promise<void>) => {
      const view: JobView = {
        id: nextId("job"), type: spec.type, sessionId: spec.sessionId, phase: "queued", done: 0, total: 0,
        state: "running", error: "", extra: spec.extra || {}, created: 0, updated: 0,
      };
      submittedJobs.push(view);
      activeJobs.add(view.id);
      const handle: JobHandle = {
        id: view.id,
        signal: new AbortController().signal,
        progress: (done, total) => {
          view.done = done;
          if (total !== undefined) {
            view.total = total;
          }
        },
        phase: (phase) => {
          view.phase = phase;
        },
        setExtra: () => {},
      };
      pendingJobs.push(
        run(handle)
          .then(() => {
            view.state = "done";
          })
          .catch((error: Error) => {
            view.state = "error";
            view.error = error.message;
          })
          .finally(() => activeJobs.delete(view.id)),
      );
      return { ...view };
    },
    isRunning: () => activeJobs.size > 0,
    list: () => submittedJobs,
    get: (id: string) => submittedJobs.find((job) => job.id === id),
  });

  provide("projects", {
    list: () => [...projects.values()],
    get: (projectId: string) => projects.get(projectId),
  });

  provide("items", {
    getSession: (sessionId: string) => sessions.get(sessionId),
    listSessions: () => [...sessions.values()],
    summaries: (projectId?: string) =>
      [...sessions.values()]
        .filter((session) => projectId === undefined || session.projectId === projectId)
        .map((session) => ({ id: session.id, label: session.label, projectId: session.projectId, producing: false, total: 0, labeled: 0, skipped: 0 })),
    status: async (sessionId: string) => ({
      session: sessions.get(sessionId) as Session, total: 0, embedded: 0, labeled: 0, skipped: 0, modelTrained: false, poolSize: 0,
    }),
    get: (itemId: string) => items.get(itemId),
    list: (sessionId: string, filter?: { status?: ItemStatus; embedded?: boolean }) =>
      [...items.values()]
        .filter((item) => item.sessionId === sessionId)
        .filter((item) => filter === undefined || filter.status === undefined || item.status === filter.status)
        .filter((item) => filter === undefined || filter.embedded === undefined || item.embedded === filter.embedded),
    setAnnotations,
    propose: (itemId: string, annotations: Annotation[]) => setAnnotations(itemId, annotations, "pending"),
    setEmbedded: (itemIds: string[], embedded: boolean) => {
      for (const itemId of itemIds) {
        items.set(itemId, { ...(items.get(itemId) as Item), embedded });
      }
    },
    remove: (itemId: string) => items.delete(itemId),
    append: (sessionId: string, newItems: NewItem[]) => newItems.map((entry) => addItem(sessionId, entry.ref, {})),
  });

  provide("labeling", {
    confirm: async (itemId: string, annotations: Annotation[]) => {
      calls.confirm.push(itemId);
      const labeled = setAnnotations(itemId, annotations, "labeled");
      (context as any).emit("items/labeled", labeled);
      return labeled;
    },
    skip: (itemId: string) => {
      calls.skip.push(itemId);
      return setAnnotations(itemId, (items.get(itemId) as Item).annotations, "skipped");
    },
    backfill: async (sessionId: string) => {
      calls.backfill.push(sessionId);
    },
  });

  const tagPrimitive: Primitive = {
    id: "tag",
    label: "Tag",
    normalize: (value) => value,
  };
  provide("primitives", { get: (id: string) => (id === "tag" ? tagPrimitive : undefined), list: () => [tagPrimitive], register: () => () => {} });

  const stubModel = {
    id: "stub-model",
    rank: async (_projectId: string, refs: string[]) => {
      calls.rank.push(refs);
      return { order: [...refs].reverse(), trained: true };
    },
    predict: async (_projectId: string, refs: string[]) => Object.fromEntries(refs.map((ref) => [ref, { a: 0.5 }])),
    insights: async () => ({ poolSize: 0, classes: [] }),
  } as unknown as ModelProvider;
  provide("models", { forProject: () => stubModel, get: () => stubModel, list: () => [stubModel], register: () => () => {} });

  function addItem(sessionId: string, ref: string, overrides: Partial<Item>): Item {
    const item: Item = {
      id: nextId("item"), sessionId, index: items.size, ref, mediaKind: "image", status: "pending",
      annotations: [], embedded: false, meta: {}, ...overrides,
    };
    items.set(item.id, item);
    return item;
  }

  return {
    context, routes, persisted, toasts, savedConfigs, calls, items,
    jobs: { submitted: submittedJobs, settle: () => Promise.all(pendingJobs).then(() => {}) },
    addProject: (overrides = {}) => {
      const project: Project = { id: nextId("project"), name: "P", config: projectConfig(overrides), created: "", updated: "" };
      projects.set(project.id, project);
      return project;
    },
    addSession: (projectId) => {
      const session: Session = { id: nextId("session"), projectId, label: "Session", source: { plugin: "s", kind: "k", params: {} }, producing: false, created: "", meta: {} };
      sessions.set(session.id, session);
      return session;
    },
    addItems: (sessionId, refs, overrides = {}) => refs.map((ref) => addItem(sessionId, ref, overrides)),
    callRoute: async (method, pattern, options = {}) => {
      const handler = routes.get(`${method} ${pattern}`);
      if (handler === undefined) {
        throw new Error(`no route ${method} ${pattern}`);
      }
      const url = `http://localhost${pattern}${options.query || ""}`;
      const init: RequestInit = { method };
      if (options.body !== undefined) {
        init.body = JSON.stringify(options.body);
      }
      return handler(new Request(url, init), options.params || {});
    },
  };
}
