import type { TriggerSpec } from "@atlas/contracts";

function trigger(id: string, label: string, scope: TriggerSpec["scope"]): TriggerSpec {
  return { id, plugin: "core-nodes", label, scope };
}

export const STANDARD_TRIGGERS: TriggerSpec[] = [
  trigger("manual", "Manual", "session"),
  trigger("session_created", "Session created", "session"),
  trigger("session_opened", "Session opened", "session"),
  trigger("session_closed", "Session closed", "session"),
  trigger("item_opened", "Item opened", "item"),
  trigger("item_accepted", "Item accepted", "item"),
  trigger("item_rejected", "Item rejected", "item"),
];
