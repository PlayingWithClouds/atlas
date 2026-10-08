import { Service } from "@neoworks/extension-system";
import type { Context } from "@neoworks/extension-system";
import type { Dispose, Primitive, PrimitivesService } from "@atlas/contracts/server";
import { ProviderRegistry } from "./registry";

export class PrimitivesCore extends Service implements PrimitivesService {
  private readonly registry = new ProviderRegistry<Primitive>("primitive");

  constructor(ctx: Context) {
    super(ctx, "primitives");
    this.ctx.effect(() => () => this.registry.clear(), "primitives:registry");
  }

  register(primitive: Primitive): Dispose {
    return this.registry.register(primitive);
  }

  get(primitiveId: string): Primitive | undefined {
    return this.registry.get(primitiveId);
  }

  list(): Primitive[] {
    return this.registry.list();
  }
}

export default PrimitivesCore;
