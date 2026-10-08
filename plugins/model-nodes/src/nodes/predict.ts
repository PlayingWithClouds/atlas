import type { WorkItem } from "@atlas/contracts";
import type { NodeResult, NodeRunContext, NodeType } from "@atlas/contracts/server";
import { numberParam, thresholdParam } from "../params";
import { TAG_PRIMITIVE_MISSING_MESSAGE, projectUsesTags, providerFor, refsOf, tagAnnotation } from "../support";
import type { ModelNodeServices } from "../support";

export const PREDICT_BATCH = 64;
export const PREDICT_THRESHOLD = 0.5;

type Probabilities = Record<string, number>;

function labelsAbove(probabilities: Probabilities, threshold: number): string[] {
  return Object.entries(probabilities)
    .filter(([, probability]) => probability >= threshold)
    .map(([name]) => name);
}

function strongestProbability(probabilities: Probabilities): number {
  return Math.max(0, ...Object.values(probabilities));
}

function bestClass(predictions: Probabilities[]): { name: string; probability: number } {
  const best = { name: "", probability: 0 };
  for (const probabilities of predictions) {
    for (const [name, probability] of Object.entries(probabilities)) {
      if (probability > best.probability) {
        best.name = name;
        best.probability = probability;
      }
    }
  }
  return best;
}

function proposalFor(item: WorkItem, probabilities: Probabilities, threshold: number): WorkItem {
  return {
    ...item,
    confidence: Math.round(strongestProbability(probabilities) * 10000) / 10000,
    probs: probabilities,
    annotations: [tagAnnotation(labelsAbove(probabilities, threshold))],
  };
}

/** Untrained, still fitting and below-threshold all look alike downstream (empty annotations), so say which. */
async function explainNothingProposed(
  services: ModelNodeServices,
  context: NodeRunContext,
  threshold: number,
  predictions: Probabilities[],
): Promise<string> {
  const provider = providerFor(services, context.project);
  const status = await provider.status(context.project.id, context.classes);
  if (!status.trained) {
    return `Predict proposed nothing: the model is not trained yet (${status.poolSize} labeled item${status.poolSize === 1 ? "" : "s"} in its pool)`;
  }
  const best = bestClass(predictions);
  if (best.name === "") {
    return "Predict proposed nothing: the model returned no probabilities for these items";
  }
  return `Predict proposed nothing: no tag reached the ${threshold.toFixed(2)} threshold (best was ${best.name} at ${best.probability.toFixed(2)})`;
}

async function predictItems(services: ModelNodeServices, items: WorkItem[], context: NodeRunContext): Promise<NodeResult> {
  if (!projectUsesTags(context.project)) {
    return { items, message: TAG_PRIMITIVE_MISSING_MESSAGE };
  }
  const threshold = numberParam(context.params, "threshold", PREDICT_THRESHOLD);
  const provider = providerFor(services, context.project);
  const byRef = await provider.predict(context.project.id, refsOf(items), context.classes);
  const predictions = items.map((item) => byRef[item.ref] || {});
  const proposals = items.map((item, index) => proposalFor(item, predictions[index], threshold));
  const proposed = proposals.some((item) => labelsAbove(item.probs as Probabilities, threshold).length > 0);
  if (proposed || items.length === 0) {
    return { items: proposals };
  }
  return { items: proposals, message: await explainNothingProposed(services, context, threshold, predictions) };
}

export function createPredictNode(services: ModelNodeServices): NodeType {
  return {
    type: "predict",
    plugin: "model-nodes",
    label: "Predict",
    description: "Propose tags above a threshold with the project's trained model (pending human review)",
    input: "items",
    output: "items",
    accepts: { status: "pending", embedded: true },
    emits: { annotation: "tag" },
    batch: PREDICT_BATCH,
    params: [thresholdParam("Threshold", PREDICT_THRESHOLD, 0.05)],
    run: (items, context) => predictItems(services, items, context),
  };
}
