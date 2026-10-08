import { Context } from "@neoworks/extension-system";
import type { Fiber } from "@neoworks/extension-system";
import DbCore from "./services/db";
import DomainRoutes from "./services/domainRoutes";
import HttpCore from "./services/http";
import JobsCore from "./services/jobs";
import ItemsCore from "./services/items";
import LabelingCore from "./services/labeling";
import LiveCore from "./services/live";
import MediaKindsCore from "./services/mediaKinds";
import ModelsCore from "./services/models";
import NotificationsCore from "./services/notifications";
import PluginsCore from "./services/plugins";
import PrimitivesCore from "./services/primitives";
import ProjectsCore from "./services/projects";
import PythonRuntime from "./python/service";
import SourcesCore from "./services/sources";
import ToolsCore from "./services/tools";
import WorkflowsCore from "./services/workflows";
import WorkspaceCore from "./services/workspace";
import { exportLogsToConsole } from "./consoleLogs";

export interface HostOptions {
  workspaceDirectory: string;
  /** Port 0 picks a free port; omitted means the default. */
  port?: number;
  /** Print `ctx.logger` output (plugin failures, Python worker stderr) to stderr. */
  logToConsole?: boolean;
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
    [ProjectsCore, undefined],
    [MediaKindsCore, undefined],
    [PrimitivesCore, undefined],
    [ModelsCore, undefined],
    [ItemsCore, undefined],
    [SourcesCore, undefined],
    [LabelingCore, undefined],
    [DomainRoutes, undefined],
    [WorkflowsCore, undefined],
    [ToolsCore, undefined],
    [PythonRuntime, undefined],
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
  if (options.logToConsole) {
    exportLogsToConsole(context);
  }
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
