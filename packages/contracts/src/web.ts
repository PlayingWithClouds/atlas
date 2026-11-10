/**
 * Web-side contribution registries. The shell renders whatever plugins register; core pages
 * are themselves registered by core plugins. Every `register` returns a disposer and must be
 * called inside `ctx.effect` so contributions vanish when their plugin unloads.
 */

import type { Component } from "svelte";
import type { Asset, AssetKind, Span } from "./schema";

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
  /** `:name` segments, e.g. `/projects/:project/label/:item`. */
  path: string;
  component: Component<{ params: Record<string, string> }>;
  /** Hides the navigation rail so the page gets the whole window (the labeling screen). */
  focus?: boolean;
}

export interface NavContribution {
  id: string;
  label: string;
  icon?: Component;
  /** Project-relative path, e.g. "queue"; the shell prefixes `/projects/:project/`. */
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

/**
 * What the labeling screen can do with a player. Times are seconds into the asset, never
 * relative to the item. Players for still images implement it as no-ops.
 */
export interface PlayerHandle {
  readonly currentTime: number;
  readonly paused: boolean;
  readonly muted: boolean;
  readonly playbackRate: number;
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  setMuted(muted: boolean): void;
  setPlaybackRate(rate: number): void;
}

export interface MediaPlayerProps {
  asset: Asset;
  /** The window to play and loop; the whole asset when absent. */
  span?: Span;
  /** Still shown before playback (the item's own poster); falls back to the asset's. */
  poster?: string;
  /** Called once the handle is usable. */
  onready?(handle: PlayerHandle): void;
  /** Called while the playhead moves and after seeks, with asset seconds. */
  ontime?(seconds: number): void;
}

/** Props of a hover-preview cell used in grids: poster until hovered, then a muted loop. */
export interface MediaPreviewProps {
  asset: Asset;
  span?: Span;
  poster?: string;
}

/** The player and the grid preview for one asset kind. */
export interface MediaPlayerContribution {
  id: string;
  kind: AssetKind;
  player: Component<MediaPlayerProps>;
  preview: Component<MediaPreviewProps>;
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
    mediaPlayers: Registry<MediaPlayerContribution>;
  }
}
