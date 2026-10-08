import type { AssistantBackend, AssistantBackendRegistry, Dispose } from "./types";

export function createBackendRegistry(): AssistantBackendRegistry {
  const backends = new Map<string, AssistantBackend>();
  return {
    register(backend: AssistantBackend): Dispose {
      if (backends.has(backend.id)) {
        throw new Error(`assistant backend "${backend.id}" is already registered`);
      }
      backends.set(backend.id, backend);
      return () => {
        if (backends.get(backend.id) === backend) {
          backends.delete(backend.id);
        }
      };
    },
    get: (backendId) => backends.get(backendId),
    list: () => [...backends.values()],
  };
}
