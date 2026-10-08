import type { ProjectConfig } from "@atlas/contracts";
import type { ModelProvider, Primitive } from "@atlas/contracts/server";

export function projectConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    mediaKind: "video",
    model: "fake-model",
    primitives: ["fake-tag"],
    labels: { groups: [{ id: "g", label: "G", classes: [{ name: "a" }, { name: "b" }] }] },
    ...overrides,
  };
}

export interface FakeModelState {
  trained: { ref: string; labels: string[] }[][];
  forgotten: string[];
}

export function fakeModel(state: FakeModelState, overrides: Partial<ModelProvider> = {}): ModelProvider {
  const unsupported = async () => {
    throw new Error("not supported");
  };
  return {
    id: "fake-model",
    label: "Fake",
    dim: 2,
    mediaKinds: ["video", "image"],
    capabilities: { textSearch: false },
    embed: async (_projectId, items) => ({ embedded: items.map((item) => item.ref) }),
    forget: async (_projectId, refs) => {
      state.forgotten.push(...refs);
    },
    train: async (_projectId, labeled) => {
      state.trained.push(labeled);
      return { poolSize: labeled.length };
    },
    predict: async () => ({}),
    rank: async (_projectId, refs) => ({ order: refs, trained: true }),
    duplicates: unsupported,
    cluster: unsupported,
    similarity: unsupported,
    insights: async () => ({ poolSize: 0, classes: [] }),
    status: async () => ({ poolSize: 0, trained: true }),
    poolDump: async () => [],
    ...overrides,
  };
}

export const fakePrimitive: Primitive = {
  id: "fake-tag",
  label: "Fake tag",
  normalize: (value) => ({ classes: value.classes }),
  trainingLabels: (value) => value.classes as string[],
};
