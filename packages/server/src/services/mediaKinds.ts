import { Service } from "@neoworks/extension-system";
import type { Context } from "@neoworks/extension-system";
import type { Dispose, MediaKind, MediaKindsService } from "@atlas/contracts/server";
import { ProviderRegistry } from "./registry";

export class MediaKindsCore extends Service implements MediaKindsService {
  private readonly registry = new ProviderRegistry<MediaKind>("media kind");

  constructor(ctx: Context) {
    super(ctx, "mediaKinds");
    this.ctx.effect(() => () => this.registry.clear(), "mediaKinds:registry");
  }

  register(mediaKind: MediaKind): Dispose {
    return this.registry.register(mediaKind);
  }

  get(mediaKindId: string): MediaKind | undefined {
    return this.registry.get(mediaKindId);
  }

  list(): MediaKind[] {
    return this.registry.list();
  }
}

export default MediaKindsCore;
