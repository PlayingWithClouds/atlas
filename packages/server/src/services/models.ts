import { Service } from "@neoworks/extension-system";
import type { Context } from "@neoworks/extension-system";
import type { Project } from "@atlas/contracts";
import { HttpError } from "@atlas/contracts/server";
import type { Dispose, ModelProvider, ModelsService } from "@atlas/contracts/server";
import { ProviderRegistry } from "./registry";

export class ModelsCore extends Service implements ModelsService {
  private readonly registry = new ProviderRegistry<ModelProvider>("model provider");

  constructor(ctx: Context) {
    super(ctx, "models");
    this.ctx.effect(() => () => this.registry.clear(), "models:registry");
  }

  register(provider: ModelProvider): Dispose {
    return this.registry.register(provider);
  }

  get(providerId: string): ModelProvider | undefined {
    return this.registry.get(providerId);
  }

  list(): ModelProvider[] {
    return this.registry.list();
  }

  forProject(project: Project): ModelProvider {
    const providerId = project.config.model;
    const provider = this.registry.get(providerId);
    if (!provider) {
      throw new HttpError(503, `model provider "${providerId}" is not loaded`);
    }
    return provider;
  }
}

export default ModelsCore;
