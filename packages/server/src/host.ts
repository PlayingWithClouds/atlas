import { Context } from "@neoworks/extension-system";
import type { Fiber } from "@neoworks/extension-system";
import DbCore from "./services/db";
import HttpCore from "./services/http";
import JobsCore from "./services/jobs";
import LiveCore from "./services/live";
import NotificationsCore from "./services/notifications";
import PluginsCore from "./services/plugins";
import WorkspaceCore from "./services/workspace";

export interface HostOptions {
  workspaceDirectory: string;
  /** Port 0 picks a free port; omitted means the default. */
  port?: number;
}

export interface Host {
  context: Context;
  stop(): Promise<void>;
}

async function disposeInReverse(fibers: Fiber[]): Promise<void> {
  for (const fiber of [...fibers].reverse()) {
    await fiber.dispose();
  }
}

/** Each core service declares its dependencies via `inject`, so this order is only for awaiting. */
async function mountCoreServices(context: Context, options: HostOptions, mounted: Fiber[]): Promise<void> {
  const mounts: [unknown, unknown][] = [
    [WorkspaceCore, { directory: options.workspaceDirectory }],
    [DbCore, undefined],
    [HttpCore, { port: options.port }],
    [LiveCore, undefined],
    [JobsCore, undefined],
    [NotificationsCore, undefined],
    // TODO(main thread): mount the python worker service (src/python/service.ts default export) here.
    [PluginsCore, undefined],
  ];
  for (const [service, config] of mounts) {
    const fiber = context.plugin(service as never, config as never);
    mounted.push(fiber);
    await fiber;
  }
}

export async function createHost(options: HostOptions): Promise<Host> {
  const context = new Context();
  const mounted: Fiber[] = [];
  const stop = () => disposeInReverse(mounted);
  try {
    await mountCoreServices(context, options, mounted);
    await context.plugins.reload();
  } catch (error) {
    await stop();
    throw error;
  }
  return { context, stop };
}
