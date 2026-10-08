/**
 * Web-side contribution registries. The shell renders whatever plugins register; core pages
 * are themselves registered by core plugins. Every `register` returns a disposer and must be
 * called inside `ctx.effect` so contributions vanish when their plugin unloads.
 */

import type { Component } from "svelte";
import type { Item, NodeParam, NodeSpec, Project, Session } from "./index";

export type Dispose = () => void;

/** Ordered, reactive list of contributions. `list()` is safe to read inside `$derived`. */
export interface Registry<T extends { id: string }> {
  register(contribution: T): Dispose;
  list(): T[];
  get(id: string): T | undefined;
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
  url(path: string): string;
}

export interface RouteContribution {
  id: string;
  /** `:name` segments, e.g. `/projects/:project/session/:session`. */
  path: string;
  component: Component<{ params: Record<string, string> }>;
}

export interface NavContribution {
  id: string;
  label: string;
  icon?: Component;
  /** Project-relative path, e.g. "data"; the shell prefixes `/projects/:project/`. */
  path: string;
  order: number;
}

export interface CommandContribution {
  id: string;
  label: string;
  group?: string;
  hotkey?: string;
  run(): void | Promise<void>;
  when?(): boolean;
}

/** Workspace that labels a whole session (grid, region canvas, ...). */
export interface GridLabelerContribution {
  id: string;
  /** Higher wins when several match. */
  priority: number;
  matches(project: Project): boolean;
  component: Component<{ project: Project; session: Session }>;
}

/** Focused view for one item. */
export interface ItemLabelerContribution {
  id: string;
  priority: number;
  matches(project: Project, item: Item): boolean;
  component: Component<{ project: Project; session: Session; item: Item }>;
}

/** Renders one item inside generic grids, keyed by media kind. */
export interface MediaCellContribution {
  id: string;
  mediaKind: string;
  component: Component<{ item: Item; session: Session; active: boolean }>;
}

/** Drawing / editing tool for one annotation primitive. */
export interface AnnotationToolContribution {
  id: string;
  primitive: string;
  label: string;
  hotkey?: string;
  component: Component<{ project: Project; item: Item }>;
}

/** UI for browsing and opening one source kind. */
export interface SourcePickerContribution {
  id: string;
  /** `<source provider id>:<kind id>`. */
  sourceKind: string;
  component: Component<{ project: Project; open(params: Record<string, unknown>): Promise<void> }>;
}

/** Preset offered when creating a project. */
export interface ProjectTemplateContribution {
  id: string;
  label: string;
  description: string;
  config: Partial<Project["config"]>;
}

export interface SettingsPaneContribution {
  id: string;
  label: string;
  order: number;
  component: Component<{ project: Project }>;
}

export interface InsightsViewContribution {
  id: string;
  label: string;
  order: number;
  component: Component<{ project: Project }>;
}

export interface OverviewWidgetContribution {
  id: string;
  order: number;
  component: Component<{ project: Project }>;
}

export interface ParamEditorContribution {
  id: string;
  kind: NodeParam["kind"];
  component: Component<{ param: NodeParam; value: unknown; change(value: unknown): void }>;
}

export interface NodePresentationContribution {
  id: string;
  /** Node type this styles. */
  nodeType: string;
  icon?: Component;
  color?: string;
  /** Replaces the default param form. */
  editor?: Component<{ spec: NodeSpec; params: Record<string, unknown>; change(params: Record<string, unknown>): void }>;
}

export interface ToolbarActionContribution {
  id: string;
  label: string;
  icon?: Component;
  order: number;
  when(project: Project, session: Session): boolean;
  run(project: Project, session: Session, selectedItems: Item[]): void | Promise<void>;
}

export interface JobRendererContribution {
  id: string;
  jobType: string;
  label: string;
}

export interface LiveHandlerContribution {
  id: string;
  messageType: string;
  handle(message: Record<string, unknown>): void;
}

export interface Toasts {
  push(message: string, level?: "info" | "success" | "error"): void;
}

declare module "@neoworks/extension-system" {
  interface Context {
    api: ApiClient;
    toasts: Toasts;
    routes: Registry<RouteContribution>;
    nav: Registry<NavContribution>;
    commands: Registry<CommandContribution>;
    gridLabelers: Registry<GridLabelerContribution>;
    itemLabelers: Registry<ItemLabelerContribution>;
    mediaCells: Registry<MediaCellContribution>;
    annotationTools: Registry<AnnotationToolContribution>;
    sourcePickers: Registry<SourcePickerContribution>;
    projectTemplates: Registry<ProjectTemplateContribution>;
    settingsPanes: Registry<SettingsPaneContribution>;
    insightsViews: Registry<InsightsViewContribution>;
    overviewWidgets: Registry<OverviewWidgetContribution>;
    paramEditors: Registry<ParamEditorContribution>;
    nodePresentations: Registry<NodePresentationContribution>;
    toolbarActions: Registry<ToolbarActionContribution>;
    jobRenderers: Registry<JobRendererContribution>;
    liveHandlers: Registry<LiveHandlerContribution>;
  }
}
