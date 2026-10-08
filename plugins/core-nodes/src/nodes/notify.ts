import type { NodeRunContext, NodeType, NotificationsService } from "@atlas/contracts/server";
import { optionParam, stringParam } from "../params";
import { renderTemplate } from "../template";
import type { WorkItem } from "@atlas/contracts";

const DEFAULT_TEMPLATE = "Workflow reached notify step";

function templateScope(items: WorkItem[], context: NodeRunContext): Record<string, unknown> {
  return {
    items,
    count: items.length,
    session: { id: context.session.id, label: context.session.label },
  };
}

export function createNotifyNode(notifications: NotificationsService): NodeType {
  return {
    type: "notify",
    plugin: "core-nodes",
    label: "Notify",
    description: "Show a notification. Template fields: {{count}}, {{items.length}}, {{session.label}}",
    input: "items",
    output: "none",
    params: [
      { key: "message", kind: "text", label: "Message", default: DEFAULT_TEMPLATE },
      optionParam("kind", "Kind", ["transient", "persistent"], "transient"),
    ],
    async run(items, context) {
      const template = stringParam(context.params, "message", DEFAULT_TEMPLATE);
      const input = {
        message: renderTemplate(template, templateScope(items, context)),
        sessionId: context.session.id,
        level: "info" as const,
      };
      if (stringParam(context.params, "kind", "transient") === "persistent") {
        notifications.persist(input);
      } else {
        notifications.toast(input);
      }
      return { items: [] };
    },
  };
}
