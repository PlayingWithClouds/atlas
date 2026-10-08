import { Service } from "@neoworks/extension-system";
import type { Context } from "@neoworks/extension-system";
import type { Item } from "@atlas/contracts";
import { HttpError } from "@atlas/contracts/server";
import type { Dispose, MediaLocation, SourceProvider, SourcesService } from "@atlas/contracts/server";
import { sourceRefOf } from "./media";
import { ProviderRegistry } from "./registry";

export class SourcesCore extends Service implements SourcesService {
  static inject = ["items"];

  private readonly registry = new ProviderRegistry<SourceProvider>("source provider");

  constructor(ctx: Context) {
    super(ctx, "sources");
    this.ctx.effect(() => () => this.registry.clear(), "sources:registry");
  }

  register(provider: SourceProvider): Dispose {
    return this.registry.register(provider);
  }

  get(providerId: string): SourceProvider | undefined {
    return this.registry.get(providerId);
  }

  list(): SourceProvider[] {
    return this.registry.list();
  }

  /** Throws HttpError 503 when the provider is not loaded. */
  require(providerId: string): SourceProvider {
    const provider = this.registry.get(providerId);
    if (!provider) {
      throw new HttpError(503, `source provider "${providerId}" is not loaded`);
    }
    return provider;
  }

  async locate(item: Item): Promise<MediaLocation> {
    const session = this.ctx.items.getSession(item.sessionId);
    if (!session) {
      throw new HttpError(404, "session not found");
    }
    const provider = this.require(providerIdFor(item, session.source.plugin));
    return provider.locate(sourceRefOf(item));
  }
}

/** Items produced by a plugin other than the session's source (e.g. extracted frames) name their provider in `meta.source`. */
function providerIdFor(item: Item, sessionProviderId: string): string {
  const overrideId = item.meta.source;
  if (typeof overrideId === "string") {
    return overrideId;
  }
  return sessionProviderId;
}

export default SourcesCore;
