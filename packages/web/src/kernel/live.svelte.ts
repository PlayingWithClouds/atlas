import type { LiveEvent } from '@atlas/contracts';

const RECONNECT_DELAY_MS = 2000;

/** The server's events plus a signal that the socket (re)opened, so screens refetch what they missed. */
export type LiveSignal = LiveEvent | { type: 'connected' };

export type LiveListener = (signal: LiveSignal) => void;

/** Reactive connection state and fan-out of live events to the screens that listen. */
export class LiveState {
  connected = $state(false);
  private readonly listeners = new Set<LiveListener>();

  subscribe(listener: LiveListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(signal: LiveSignal): void {
    for (const listener of this.listeners) {
      listener(signal);
    }
  }
}

export function webSocketUrl(location: Pick<Location, 'protocol' | 'host'>): string {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${location.host}/api/live`;
}

export function parseLiveEvent(data: unknown): LiveEvent | undefined {
  try {
    const message = JSON.parse(String(data));
    if (message !== null && typeof message === 'object' && typeof message.type === 'string') {
      return message as LiveEvent;
    }
  } catch (error) {
    console.error('[live] bad frame', error);
  }
  return undefined;
}

export interface LiveConnectionOptions {
  state: LiveState;
  url: string;
}

/** Owns the single WebSocket: reconnects every 2s and forwards events. Returns a disposer. */
export function connectLive(options: LiveConnectionOptions): () => void {
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function onFrame(data: unknown): void {
    const event = parseLiveEvent(data);
    if (event !== undefined) {
      options.state.emit(event);
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
      options.state.emit({ type: 'connected' });
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
