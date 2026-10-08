import { Service } from "@neoworks/extension-system";
import type { Context } from "@neoworks/extension-system";
import type { ServerWebSocket } from "bun";
import type { Dispose, LiveService } from "@atlas/contracts/server";
import type { HttpCore } from "./http";

export class LiveCore extends Service implements LiveService {
  static inject = ["http"];

  private readonly slices = new Map<string, () => unknown>();
  private readonly clients = new Set<ServerWebSocket<unknown>>();
  private pushScheduled = false;
  private disposed = false;

  constructor(ctx: Context) {
    super(ctx, "live");
    const http = ctx.http as unknown as HttpCore;
    this.ctx.effect(() => http.attachWebSocket({
      open: (socket) => this.addClient(socket),
      close: (socket) => this.clients.delete(socket),
    }), "live:websocket");
    this.ctx.effect(() => () => this.shutdown(), "live:clients");
  }

  provideState(key: string, read: () => unknown): Dispose {
    this.slices.set(key, read);
    this.notify();
    return () => {
      if (this.slices.get(key) !== read) {
        return;
      }
      this.slices.delete(key);
      this.notify();
    };
  }

  notify(): void {
    if (this.pushScheduled || this.disposed) {
      return;
    }
    this.pushScheduled = true;
    queueMicrotask(() => {
      this.pushScheduled = false;
      this.send(this.snapshot());
    });
  }

  broadcast(type: string, payload: Record<string, unknown>): void {
    this.send({ type, ...payload });
  }

  private addClient(socket: ServerWebSocket<unknown>): void {
    this.clients.add(socket);
    socket.send(JSON.stringify(this.snapshot()));
  }

  private snapshot(): Record<string, unknown> {
    const message: Record<string, unknown> = { type: "state" };
    for (const [key, read] of this.slices) {
      message[key] = this.readSlice(key, read);
    }
    return message;
  }

  private readSlice(key: string, read: () => unknown): unknown {
    try {
      return read();
    } catch (error) {
      this.ctx.logger.error(`state slice "${key}" failed`, error);
      return null;
    }
  }

  private send(message: Record<string, unknown>): void {
    if (this.clients.size === 0 || this.disposed) {
      return;
    }
    const encoded = JSON.stringify(message);
    for (const socket of this.clients) {
      socket.send(encoded);
    }
  }

  private shutdown(): void {
    this.disposed = true;
    for (const socket of this.clients) {
      socket.close();
    }
    this.clients.clear();
    this.slices.clear();
  }
}

export default LiveCore;
