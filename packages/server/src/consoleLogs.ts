import { Logger } from "@neoworks/extension-system";
import type { Context, Exporter, Message } from "@neoworks/extension-system";

/** Without an exporter the kernel buffers `ctx.logger` output and nothing reaches the terminal. */
export function exportLogsToConsole(context: Context): void {
  const exporter: Exporter = {
    colors: false,
    export(message: Message) {
      console.error(Logger.format(exporter, message));
    },
  };
  context.logger.exporter(exporter);
}
