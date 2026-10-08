import type { Tool } from "@atlas/contracts/server";
import { sessionTools } from "./sessionTools";
import type { SessionToolServices } from "./sessionTools";
import { workflowTools } from "./workflowTools";
import type { WorkflowToolServices } from "./workflowTools";

export type AssistantToolServices = SessionToolServices & WorkflowToolServices;

/** The read-and-propose surface. Nothing here confirms labels, trains, deletes or runs a workflow. */
export function assistantTools(services: AssistantToolServices): Tool[] {
  return [...sessionTools(services), ...workflowTools(services)];
}
