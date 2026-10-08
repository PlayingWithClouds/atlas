import type { Registry, LiveHandlerContribution } from '@atlas/contracts/web';
import type { JobView, NotificationView, PluginView, Project, SessionSummary } from '@atlas/contracts';
import type { ToastQueue, ToastView } from './toasts.svelte';

const RECONNECT_DELAY_MS = 2000;

/** Reactive mirror of the server's `state` snapshots. */
export class LiveState {
  connected = $state(false);
  jobs = $state.raw<JobView[]>([]);
  sessions = $state.raw<SessionSummary[]>([]);
  plugins = $state.raw<PluginView[]>([]);
  projects = $state.raw<Project[]>([]);
  notifications = $state.raw<NotificationView[]>([]);
  /** True after the first snapshot, so pages can tell "loading" from "empty". */
  loaded = $state(false);

  apply(snapshot: Record<string, unknown>): void {
    this.jobs = listOrCurrent(snapshot.jobs, this.jobs);
    this.sessions = listOrCurrent(snapshot.sessions, this.sessions);
    this.plugins = listOrCurrent(snapshot.plugins, this.plugins);
    this.projects = listOrCurrent(snapshot.projects, this.projects);
    this.notifications = listOrCurrent(snapshot.notifications, this.notifications);
    this.loaded = true;
  }
}

function listOrCurrent<T>(incoming: unknown, current: T[]): T[] {
  if (Array.isArray(incoming)) {
    return incoming as T[];
  }
  return current;
}

export function webSocketUrl(location: Pick<Location, 'protocol' | 'host'>): string {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${location.host}/api/ws`;
}

interface ToastPayload {
  id?: string;
  message?: string;
  level?: ToastView['level'];
}

export interface LiveConnectionOptions {
  state: LiveState;
  toasts: ToastQueue;
  handlers: Registry<LiveHandlerContribution>;
  url: string;
}

/** Owns the single WebSocket: reconnects every 2s, routes frames by `type`. Returns a disposer. */
export function connectLive(options: LiveConnectionOptions): () => void {
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function dispatch(message: Record<string, unknown>): void {
    if (message.type === 'state') {
      options.state.apply(message);
      return;
    }
    if (message.type === 'toast') {
      showToast(message.toast as ToastPayload | undefined);
      return;
    }
    for (const handler of options.handlers.list()) {
      if (handler.messageType === message.type) {
        handler.handle(message);
      }
    }
  }

  function showToast(payload: ToastPayload | undefined): void {
    if (!payload || typeof payload.message !== 'string') {
      return;
    }
    const level = payload.level === undefined ? 'info' : payload.level;
    options.toasts.push(payload.message, level, payload.id);
  }

  function onFrame(data: unknown): void {
    try {
      dispatch(JSON.parse(String(data)));
    } catch (error) {
      console.error('[live] bad frame', error);
    }
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer !== undefined) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      open();
    }, RECONNECT_DELAY_MS);
  }

  function open(): void {
    const opened = new WebSocket(options.url);
    socket = opened;
    opened.onopen = () => {
      options.state.connected = true;
    };
    opened.onmessage = (event) => onFrame(event.data);
    opened.onclose = () => {
      options.state.connected = false;
      socket = undefined;
      scheduleReconnect();
    };
    opened.onerror = () => opened.close();
  }

  open();

  return () => {
    stopped = true;
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
    }
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
    options.state.connected = false;
  };
}
