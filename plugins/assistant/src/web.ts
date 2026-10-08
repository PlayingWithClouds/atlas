import type { Context } from "@neoworks/extension-system";
import SparkleIcon from "phosphor-svelte/lib/SparkleIcon";
import AssistantPage from "./web/AssistantPage.svelte";
import { conversation } from "./web/conversation.svelte";

export default {
  name: "assistant",
  inject: ["routes", "nav", "commands"],
  apply(ctx: Context) {
    ctx.effect(
      () => ctx.routes.register({ id: "assistant:page", path: "/projects/:project/assistant", component: AssistantPage }),
      "route:assistant",
    );
    ctx.effect(
      () => ctx.nav.register({ id: "assistant:nav", label: "Assistant", icon: SparkleIcon, path: "assistant", order: 80 }),
      "nav:assistant",
    );
    ctx.effect(
      () =>
        ctx.commands.register({
          id: "assistant:open",
          label: "Open assistant",
          group: "App",
          run: () => openAssistant(ctx),
          when: () => currentProjectId(ctx) !== undefined,
        }),
      "command:assistant",
    );
    // An answer still streaming when the plugin unloads must not keep running.
    ctx.effect(() => () => conversation.stop(), "assistant:conversation");
  },
};

function currentProjectId(ctx: Context): string | undefined {
  const current = ctx.router.current;
  if (current === undefined) {
    return undefined;
  }
  return current.params.project;
}

function openAssistant(ctx: Context): void {
  const projectId = currentProjectId(ctx);
  if (projectId === undefined) {
    return;
  }
  ctx.router.navigate(`/projects/${projectId}/assistant`);
}
