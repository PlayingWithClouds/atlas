import type { Context } from "@neoworks/extension-system";
import type { ProjectConfig } from "../../packages/contracts/src/index";
import type { ModelProvider, Primitive, SourceProvider } from "../../packages/contracts/src/server";

export function projectConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    mediaKind: "fake-media",
    model: "fake-model",
    primitives: ["fake-tag"],
    labels: { groups: [{ id: "g", label: "G", classes: [{ name: "a" }, { name: "b" }] }] },
    ...overrides,
  };
}

export interface FakeModelState {
  trained: { ref: string; labels: string[] }[][];
  failTraining: boolean;
  rankOrder: string[];
  forgotten: string[];
  predictions: Record<string, Record<string, number>>;
}

export function fakeModel(state: FakeModelState, overrides: Partial<ModelProvider> = {}): ModelProvider {
  const unsupported = async () => {
    throw new Error("not supported");
  };
  return {
    id: "fake-model",
    label: "Fake",
    dim: 2,
    mediaKinds: ["fake-media"],
    capabilities: { textSearch: false },
    embed: async (_projectId, items) => ({ embedded: items.map((item) => item.ref) }),
    forget: async (_projectId, refs) => {
      state.forgotten.push(...refs);
    },
    train: async (_projectId, labeled) => {
      if (state.failTraining) {
        throw new Error("boom");
      }
      state.trained.push(labeled);
      return { poolSize: labeled.length };
    },
    predict: async () => state.predictions,
    rank: async (_projectId, refs) => ({ order: state.rankOrder.length > 0 ? state.rankOrder : refs, trained: true }),
    duplicates: unsupported,
    cluster: unsupported,
    similarity: unsupported,
    insights: async () => ({ poolSize: 0, classes: [] }),
    status: async () => ({ poolSize: 7, trained: true }),
    poolDump: async () => [],
    ...overrides,
  };
}

export const fakePrimitive: Primitive = {
  id: "fake-tag",
  label: "Fake tag",
  normalize: (value) => {
    if (value.drop === true) {
      return null;
    }
    return { classes: value.classes, normalized: true };
  },
  trainingLabels: (value) => value.classes as string[],
};

export function fakeSource(itemCount = 3): SourceProvider {
  return {
    id: "fake-source",
    kinds: () => [{ id: "list", label: "List", itemNoun: "thing", browsable: true }],
    list: async () => ({ items: [{ id: "x", title: "X" }] }),
    resolve: async (_kind, params) => ({
      label: `resolved ${String(params.name)}`,
      items: Array.from({ length: itemCount }, (_, index) => ({ ref: `ref-${index}`, mediaKind: "fake-media" })),
    }),
    locate: (ref) => ({ kind: "file", path: `/tmp/${ref}` }),
  };
}

/** Mounts a plugin that registers the given providers; returns its fiber. */
export function mountProviders(
  host: { context: Context },
  providers: { model?: ModelProvider; source?: SourceProvider; primitive?: Primitive; mediaKind?: import("../../packages/contracts/src/server").MediaKind },
) {
  const plugin = (ctx: Context) => {
    if (providers.model) {
      const model = providers.model;
      ctx.effect(() => ctx.models.register(model), "fake:model");
    }
    if (providers.source) {
      const source = providers.source;
      ctx.effect(() => ctx.sources.register(source), "fake:source");
    }
    if (providers.primitive) {
      const primitive = providers.primitive;
      ctx.effect(() => ctx.primitives.register(primitive), "fake:primitive");
    }
    if (providers.mediaKind) {
      const mediaKind = providers.mediaKind;
      ctx.effect(() => ctx.mediaKinds.register(mediaKind), "fake:mediaKind");
    }
  };
  plugin.inject = ["models", "sources", "primitives", "mediaKinds"];
  return host.context.plugin(plugin as never, undefined as never);
}
